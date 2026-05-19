const ORDERFLOW_BASE_URL =
  process.env.ORDERFLOW_BASE_URL || "https://ifd.orderflow-wms.co.uk/web";

function escapeXml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildImportItem({
  sku,
  barcode,
  title,
  weight,
  priceNet,
  activated,
  operation,
}) {
  const op = operation === "update" ? "update" : "insert";
  const description = `TEST ${title || ""}`.trim();
  const hasWeight = weight !== "" && weight !== null && weight !== undefined;
  const hasPrice = priceNet !== "" && priceNet !== null && priceNet !== undefined;
  const activatedValue = activated === false ? "false" : "true";

  const fields = [
    `externalReference=${escapeXml(sku)}`,
    `sku=${escapeXml(sku)}`,
    `description=${escapeXml(description)}`,
    `type=default`,
    `activated=${activatedValue}`,
    hasWeight ? `weight=${escapeXml(weight)}` : null,
    hasWeight ? `weightUnits=grams` : null,
    hasPrice ? `priceNet=${escapeXml(priceNet)}` : null,
    barcode ? `barcode=${escapeXml(barcode)}` : null,
  ]
    .filter(Boolean)
    .join("\n      ");

  const aliasOp = op === "update" ? "update" : "insert";
  const barcodeElement = barcode
    ? `\n      <productAlias type="barcode" value="${escapeXml(
        barcode,
      )}" operation="${aliasOp}"/>`
    : "";

  return `  <import type="product" operation="${op}" externalReference="${escapeXml(
    sku,
  )}">
      ${fields}${barcodeElement}
  </import>`;
}

function isDefaultOnlyVariant(variants) {
  if (!variants || variants.length !== 1) return false;
  const v = variants[0];
  return (
    v.title === "Default Title" ||
    (v.option1 === "Default Title" && !v.option2 && !v.option3)
  );
}

function buildItemSpecs(product) {
  const productHandle = product?.handle || String(product?.id || "");
  const productTitle = product?.title || "";
  const variants = product?.variants?.length ? product.variants : [];
  const activated = product?.status === "active";

  if (variants.length === 0 || isDefaultOnlyVariant(variants)) {
    const v = variants[0] || {};
    return [
      {
        sku: v.sku || productHandle,
        barcode: v.barcode || "",
        title: productTitle,
        weight: v.grams ?? "",
        priceNet: v.price ?? "",
        activated,
      },
    ];
  }

  return variants.map((variant) => ({
    sku: variant.sku || `${productHandle}-${variant.id}`,
    barcode: variant.barcode || "",
    title: `${productTitle}${variant.title ? ` - ${variant.title}` : ""}`,
    weight: variant.grams ?? "",
    priceNet: variant.price ?? "",
    activated,
  }));
}

function buildImportItemsXml(itemSpecs) {
  const items = itemSpecs.map((spec) => buildImportItem(spec));
  return `<?xml version="1.0" encoding="UTF-8"?>
<imports>
${items.join("\n")}
</imports>`;
}

async function requestXml(method, path, xml, options = {}) {
  const { scope = "warehouse" } = options;
  const user = process.env.ORDERFLOW_USER;
  const password = process.env.ORDERFLOW_PASSWORD;

  if (!user || !password) {
    throw new Error(
      "Missing OrderFlow env vars: ORDERFLOW_USER, ORDERFLOW_PASSWORD must be set.",
    );
  }

  const url = `${ORDERFLOW_BASE_URL.replace(/\/$/, "")}${path}`;
  const encodedPassword = Buffer.from(password, "utf-8").toString("base64");

  console.log(`OrderFlow ${method} ${url}${xml ? `\n${xml}` : ""}`);

  const headers = {
    user,
    password: encodedPassword,
    Authorization: `Basic ${Buffer.from(`${user}:${password}`, "utf-8").toString("base64")}`,
  };

  if (scope === "order") {
    const channel = process.env.ORDERFLOW_CHANNEL;
    if (!channel) {
      throw new Error(
        "Missing OrderFlow env var: ORDERFLOW_CHANNEL must be set for order endpoints.",
      );
    }
    headers.channel = channel;
  } else {
    const org = process.env.ORDERFLOW_ORG;
    if (!org) {
      throw new Error(
        "Missing OrderFlow env var: ORDERFLOW_ORG must be set for warehouse endpoints.",
      );
    }
    headers.organisation = org;
  }

  const init = { method, headers };
  if (xml) {
    init.headers["Content-Type"] = "application/xml";
    init.body = xml;
  }

  const response = await fetch(url, init);

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OrderFlow ${path} failed (${response.status}): ${body}`);
  }
  return { status: response.status, body };
}

const postXml = (path, xml, options) => requestXml("POST", path, xml, options);
const getXml = (path, options) => requestXml("GET", path, undefined, options);

export async function productsExist(skus) {
  const unique = [...new Set(skus.filter(Boolean))];
  if (unique.length === 0) return new Set();

  const params = new URLSearchParams({
    externalReferences: unique.join(","),
  });
  const path = `/remotewarehouse/inventory.xml?${params.toString()}`;

  const { body } = await getXml(path);

  const existing = new Set();
  const regex = /externalReference="([^"]+)"/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    existing.add(match[1]);
  }
  return existing;
}

export async function syncProduct(product) {
  const specs = buildItemSpecs(product);
  if (specs.length === 0) {
    return { skipped: true, reason: "no items to sync" };
  }

  const existingSkus = await productsExist(specs.map((s) => s.sku));

  const specsWithOps = specs.map((spec) => ({
    ...spec,
    operation: existingSkus.has(spec.sku) ? "update" : "insert",
  }));

  console.log(
    "OrderFlow sync operations:",
    specsWithOps.map(({ sku, operation }) => ({ sku, operation })),
  );

  const xml = buildImportItemsXml(specsWithOps);
  return postXml("/remotewarehouse/imports/importitems.xml", xml);
}

export async function importItems(product) {
  return syncProduct(product);
}

function buildStockMoveTaskXml({ sku, quantity, externalReference }) {
  const taskDefinition =
    process.env.ORDERFLOW_STOCK_ADJUST_TASK || "external_stock_adjustment";
  const site = process.env.ORDERFLOW_SITE || "Default";

  return `<?xml version="1.0" encoding="UTF-8"?>
<imports>
  <import type="stockMoveTask" operation="insert">
    externalReference=${escapeXml(externalReference)}
    taskDefinition=${escapeXml(taskDefinition)}
    site=${escapeXml(site)}
    stockMoveLine.1.product=${escapeXml(sku)}
    stockMoveLine.1.suggestedQuantity=${escapeXml(quantity)}
    stockMoveLine.1.stockMoveTask=stockMoveTask
  </import>
</imports>`;
}

export async function adjustStock({ sku, quantity, reference }) {
  if (!sku) throw new Error("adjustStock: sku is required");
  if (quantity === null || quantity === undefined) {
    throw new Error("adjustStock: quantity is required");
  }

  const xml = buildStockMoveTaskXml({
    sku,
    quantity,
    externalReference:
      reference || `shopify-inv-${sku}-${Date.now()}`,
  });
  return postXml("/remotewarehouse/imports/importitems.xml", xml);
}

function toMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function formatMoney(value) {
  return toMoney(value).toFixed(2);
}

function formatPlacedDate(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function sumTaxLines(taxLines) {
  if (!Array.isArray(taxLines)) return 0;
  return taxLines.reduce((total, line) => total + toMoney(line?.price), 0);
}

function isFulfillableLineItem(item) {
  if (!item) return false;
  if (item.gift_card) return false;
  if (item.requires_shipping === false) return false;
  return true;
}

function buildOrderLines(order) {
  const items = (order.line_items || []).filter(isFulfillableLineItem);
  const taxesIncluded = order.taxes_included === true;

  return items.map((item) => {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = toMoney(item.price);
    const lineTax = sumTaxLines(item.tax_lines);

    let gross;
    let net;
    if (taxesIncluded) {
      gross = toMoney(unitPrice * quantity);
      net = toMoney(gross - lineTax);
    } else {
      net = toMoney(unitPrice * quantity);
      gross = toMoney(net + lineTax);
    }

    return {
      sku: item.sku || "",
      quantity,
      totalPriceNet: net,
      totalPriceGross: gross,
      totalTax: toMoney(lineTax),
    };
  });
}

const TEST_PREFIX = "TEST-";
const TEST_INSTRUCTION_PREFIX = "TEST ORDER - ";
const TEST_NAME_PREFIX = "TEST ";

function buildOrderExternalReference(order) {
  const raw = order?.name || String(order?.id || "");
  if (!raw) return "";
  return raw.startsWith(TEST_PREFIX) ? raw : `${TEST_PREFIX}${raw}`;
}

function buildOrderImportXml(order) {
  const externalReference = buildOrderExternalReference(order);
  const shipping = order.shipping_address || {};
  const billing = order.billing_address || shipping;
  const lines = buildOrderLines(order);

  const totalGross = toMoney(order.total_price);
  const totalTax = toMoney(order.total_tax);
  const totalNet = toMoney(totalGross - totalTax);

  const shippingLine = (order.shipping_lines || [])[0] || {};
  const shippingGross = toMoney(shippingLine.price || 0);
  const shippingTax = sumTaxLines(shippingLine.tax_lines);
  const shippingNet = toMoney(shippingGross - shippingTax);

  const placed = formatPlacedDate(order.created_at);
  const shipmentRef = `${externalReference}_S1`;

  const fields = [
    `state=created`,
    `validated=true`,
    placed ? `placed=${placed}` : null,
    order.currency ? `currency=${escapeXml(order.currency)}` : null,
    `totalPriceNet=${formatMoney(totalNet)}`,
    `totalPriceGross=${formatMoney(totalGross)}`,
    `totalTax=${formatMoney(totalTax)}`,
    `shippingPriceNet=${formatMoney(shippingNet)}`,
    `shippingPriceGross=${formatMoney(shippingGross)}`,
    `shippingTax=${formatMoney(shippingTax)}`,
    shipping.address1
      ? `deliveryAddressLine1=${escapeXml(shipping.address1)}`
      : null,
    shipping.address2
      ? `deliveryAddressLine2=${escapeXml(shipping.address2)}`
      : null,
    shipping.city ? `deliveryAddressLine3=${escapeXml(shipping.city)}` : null,
    shipping.country_code
      ? `deliveryCountryCode=${escapeXml(shipping.country_code)}`
      : null,
    shipping.zip ? `deliveryPostCode=${escapeXml(shipping.zip)}` : null,
    shipping.name
      ? `deliveryContactName=${escapeXml(`${TEST_NAME_PREFIX}${shipping.name}`)}`
      : `deliveryContactName=${escapeXml("TEST ORDER")}`,
    order.email ? `deliveryEmailAddress=${escapeXml(order.email)}` : null,
    shipping.phone
      ? `deliveryDayPhoneNumber=${escapeXml(shipping.phone)}`
      : null,
    billing.address1
      ? `invoiceAddressLine1=${escapeXml(billing.address1)}`
      : null,
    billing.address2
      ? `invoiceAddressLine2=${escapeXml(billing.address2)}`
      : null,
    billing.city ? `invoiceAddressLine3=${escapeXml(billing.city)}` : null,
    billing.country_code
      ? `invoiceCountryCode=${escapeXml(billing.country_code)}`
      : null,
    billing.zip ? `invoicePostCode=${escapeXml(billing.zip)}` : null,
    billing.name
      ? `invoiceContactName=${escapeXml(`${TEST_NAME_PREFIX}${billing.name}`)}`
      : `invoiceContactName=${escapeXml("TEST ORDER")}`,
    order.email ? `invoiceEmailAddress=${escapeXml(order.email)}` : null,
    `shipment.externalReference=${escapeXml(shipmentRef)}`,
    `shipment.state=ready`,
    `shipment.deliveryInstruction=${escapeXml(
      `${TEST_INSTRUCTION_PREFIX}${order.note || "do not fulfil"}`,
    )}`,
    `shipment.itemCount=${lines.reduce((n, l) => n + l.quantity, 0)}`,
    `shipment.orderItem=entity:order`,
  ];

  lines.forEach((line, index) => {
    const n = index + 1;
    fields.push(
      `orderLine.${n}.product.externalReference=${escapeXml(line.sku)}`,
      `orderLine.${n}.quantity=${line.quantity}`,
      `orderLine.${n}.state=created`,
      `orderLine.${n}.totalPriceNet=${formatMoney(line.totalPriceNet)}`,
      `orderLine.${n}.totalPriceGross=${formatMoney(line.totalPriceGross)}`,
      `orderLine.${n}.totalTax=${formatMoney(line.totalTax)}`,
      `orderLine.${n}.shipment=entity:shipment`,
    );
  });

  const body = fields.filter(Boolean).join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<imports>
  <import type="order" operation="insert" externalReference="${escapeXml(externalReference)}">
    ${body}
  </import>
</imports>`;
}

function parseImportResult(xmlBody) {
  const status = /<import[^>]*\bstatus\s*=\s*"([^"]+)"/i.exec(xmlBody)?.[1];
  const normalized = status ? status.toLowerCase() : null;

  const duplicate = normalized === "duplicate";
  const success = normalized === "success" || normalized === "ok";
  const failed =
    normalized === "failure" ||
    normalized === "fail" ||
    normalized === "error" ||
    (!duplicate && !success && /<error\b/i.test(xmlBody));

  return { status: normalized, duplicate, failed };
}

export async function syncOrder(order) {
  const externalReference = buildOrderExternalReference(order);
  if (!externalReference) {
    throw new Error("syncOrder: order is missing name/id");
  }

  const allItems = order.line_items || [];
  const fulfillableItems = allItems.filter(isFulfillableLineItem);
  if (fulfillableItems.length === 0) {
    const summary = allItems.map((item) => ({
      sku: item?.sku,
      title: item?.title,
      gift_card: item?.gift_card,
      requires_shipping: item?.requires_shipping,
    }));
    console.warn(
      `OrderFlow skip — no fulfillable line items on ${externalReference}. line_items=${JSON.stringify(summary)}`,
    );
    return {
      skipped: true,
      reason: "no fulfillable line items (gift cards / digital only)",
    };
  }

  const missingSkus = fulfillableItems
    .filter((item) => !item.sku)
    .map((item) => `${item.title || item.id}`);
  if (missingSkus.length > 0) {
    throw new Error(
      `Order ${externalReference} has line items without SKU: ${missingSkus.join(", ")}. Reject at webhook stage.`,
    );
  }

  const xml = buildOrderImportXml(order);
  const result = await postXml(
    "/remoteorder/imports/importitems.xml",
    xml,
    { scope: "order" },
  );

  console.log(
    `OrderFlow order import response for ${externalReference}:\n${result.body}`,
  );

  const parsed = parseImportResult(result.body);
  if (parsed.failed) {
    throw new Error(
      `OrderFlow order import returned failure for ${externalReference} (status=${parsed.status ?? "unknown"}): ${result.body}`,
    );
  }
  if (parsed.duplicate) {
    return { ...result, duplicate: true };
  }

  return result;
}

export async function cancelOrder(order) {
  const externalReference = buildOrderExternalReference(order);
  if (!externalReference) {
    throw new Error("cancelOrder: order is missing name/id");
  }

  const params = new URLSearchParams({
    externalReference,
    cancelChangesExternalReference: "false",
  });
  const path = `/remoteorder/order/cancel.xml?${params.toString()}`;

  return postXml(path, undefined, { scope: "order" });
}

export { buildOrderImportXml };

function formatOrderFlowTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function parseAttributes(tag) {
  const attrs = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function extractTagBlocks(xml, tagName) {
  const open = new RegExp(`<${tagName}(\\s[^>]*)?>`, "g");
  const blocks = [];
  let match;
  while ((match = open.exec(xml)) !== null) {
    const start = match.index;
    const close = xml.indexOf(`</${tagName}>`, start);
    if (close === -1) break;
    blocks.push(xml.slice(start, close + tagName.length + 3));
  }
  return blocks;
}

function extractTagText(xml, tagName) {
  const match = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`,
  ).exec(xml);
  if (!match) return "";
  return match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function parseDespatchesXml(xml) {
  const shipmentBlocks = extractTagBlocks(xml, "shipment");
  return shipmentBlocks.map((block) => {
    const orderLineBlocks = extractTagBlocks(block, "orderLine");
    const orderLines = orderLineBlocks.map((lineBlock) => ({
      productReference: extractTagText(lineBlock, "productReference"),
      quantity: Number(extractTagText(lineBlock, "quantity")) || 0,
      thirdPartyReference: extractTagText(lineBlock, "thirdPartyReference"),
    }));

    return {
      reference: extractTagText(block, "reference"),
      orderReference: extractTagText(block, "orderReference"),
      originatingOrderReference: extractTagText(
        block,
        "originatingOrderReference",
      ),
      state: extractTagText(block, "state"),
      carrier: extractTagText(block, "carrier"),
      courier: extractTagText(block, "courier"),
      service: extractTagText(block, "service"),
      despatchReference: extractTagText(block, "despatchReference"),
      trackingUrl: extractTagText(block, "trackingUrl"),
      completed: extractTagText(block, "completed"),
      orderLines,
    };
  });
}

export async function getRecentDespatches({ from, to, includeOrderLines = true } = {}) {
  if (!from) throw new Error("getRecentDespatches: from is required");
  const params = new URLSearchParams({
    from: formatOrderFlowTimestamp(from),
    includeOrderLines: includeOrderLines ? "true" : "false",
  });
  if (to) params.set("to", formatOrderFlowTimestamp(to));

  const path = `/remoteorder/shipment/despatches.xml?${params.toString()}`;
  const result = await getXml(path, { scope: "order" });
  return parseDespatchesXml(result.body);
}
