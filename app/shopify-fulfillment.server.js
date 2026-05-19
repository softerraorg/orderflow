import { unauthenticated } from "./shopify.server";

const CARRIER_MAP = {
  dpd: "DPD",
  dpd_api: "DPD",
  royal_mail: "Royal Mail",
  royalmail: "Royal Mail",
  ups: "UPS",
  fedex: "FedEx",
  dhl: "DHL",
  parcelforce: "Parcelforce",
  evri: "Evri",
  hermes: "Evri",
};

function mapCarrier(orderflowCarrier) {
  if (!orderflowCarrier) return "Other";
  const key = orderflowCarrier.toLowerCase().trim();
  if (CARRIER_MAP[key]) return CARRIER_MAP[key];
  for (const [prefix, value] of Object.entries(CARRIER_MAP)) {
    if (key.startsWith(prefix)) return value;
  }
  return orderflowCarrier;
}

function stripTestPrefix(name) {
  return (name || "").replace(/^TEST-/, "");
}

async function getAdmin() {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!shop) {
    throw new Error(
      "Missing SHOPIFY_SHOP_DOMAIN env var (e.g. herculean-app.myshopify.com).",
    );
  }
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

const ORDER_LOOKUP_QUERY = `#graphql
  query OrderByName($query: String!) {
    orders(first: 1, query: $query) {
      edges {
        node {
          id
          name
          displayFulfillmentStatus
          fulfillmentOrders(first: 20, query: "status:OPEN") {
            edges {
              node {
                id
                status
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      remainingQuantity
                      sku
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo {
          number
          url
          company
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function findShopifyOrder(admin, shopifyOrderName) {
  const response = await admin.graphql(ORDER_LOOKUP_QUERY, {
    variables: { query: `name:${shopifyOrderName}` },
  });
  const json = await response.json();
  const edges = json?.data?.orders?.edges || [];
  return edges[0]?.node || null;
}

export async function fulfillShopifyOrder({
  shopifyOrderName,
  trackingNumber,
  trackingUrl,
  courier,
  productSkus,
}) {
  const lookupName = stripTestPrefix(shopifyOrderName);
  if (!lookupName) {
    throw new Error("fulfillShopifyOrder: missing shopifyOrderName");
  }

  const admin = await getAdmin();
  const order = await findShopifyOrder(admin, lookupName);
  if (!order) {
    return {
      skipped: true,
      reason: `Shopify order not found for name '${lookupName}'`,
    };
  }

  const openFulfillmentOrders = (order.fulfillmentOrders?.edges || [])
    .map((edge) => edge.node)
    .filter((fo) => fo.status === "OPEN");

  if (openFulfillmentOrders.length === 0) {
    return {
      skipped: true,
      reason: `No open fulfillment orders on Shopify order '${order.name}' (already fulfilled?)`,
      shopifyOrderId: order.id,
    };
  }

  const wantedSkus = new Set(
    (productSkus || []).filter(Boolean).map((sku) => sku.toLowerCase()),
  );

  const lineItemsByFulfillmentOrder = openFulfillmentOrders
    .map((fo) => {
      const lineItems = (fo.lineItems?.edges || [])
        .map((edge) => edge.node)
        .filter((li) => li.remainingQuantity > 0)
        .filter((li) =>
          wantedSkus.size === 0
            ? true
            : li.sku && wantedSkus.has(li.sku.toLowerCase()),
        )
        .map((li) => ({ id: li.id, quantity: li.remainingQuantity }));
      return { fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: lineItems };
    })
    .filter((entry) => entry.fulfillmentOrderLineItems.length > 0);

  if (lineItemsByFulfillmentOrder.length === 0) {
    return {
      skipped: true,
      reason: `No matching open line items on Shopify order '${order.name}' for SKUs ${[...wantedSkus].join(",")}`,
      shopifyOrderId: order.id,
    };
  }

  const variables = {
    fulfillment: {
      lineItemsByFulfillmentOrder,
      notifyCustomer: true,
      trackingInfo: trackingNumber
        ? {
            number: trackingNumber,
            company: mapCarrier(courier),
            ...(trackingUrl ? { url: trackingUrl } : {}),
          }
        : undefined,
    },
  };

  const response = await admin.graphql(FULFILLMENT_CREATE_MUTATION, {
    variables,
  });
  const json = await response.json();
  const userErrors = json?.data?.fulfillmentCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(
      `Shopify fulfillmentCreate userErrors for order ${order.name}: ${JSON.stringify(userErrors)}`,
    );
  }

  const fulfillment = json?.data?.fulfillmentCreate?.fulfillment;
  return {
    ok: true,
    shopifyOrderId: order.id,
    shopifyOrderName: order.name,
    fulfillmentId: fulfillment?.id || null,
    status: fulfillment?.status || null,
  };
}
