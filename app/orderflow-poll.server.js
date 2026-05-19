import prisma from "./db.server";
import { getRecentDespatches } from "./orderflow.server";
import { fulfillShopifyOrder } from "./shopify-fulfillment.server";

const POLL_KEY = "orderflow:despatches";
const DEFAULT_BACKFILL_HOURS = 24;

async function loadCursor() {
  const row = await prisma.pollState.findUnique({ where: { key: POLL_KEY } });
  if (row) return row.cursor;
  const fallback = new Date(Date.now() - DEFAULT_BACKFILL_HOURS * 3600 * 1000);
  return fallback;
}

async function saveCursor(cursor) {
  await prisma.pollState.upsert({
    where: { key: POLL_KEY },
    update: { cursor },
    create: { key: POLL_KEY, cursor },
  });
}

function parseDespatchedDate(value) {
  if (!value) return null;
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function runDespatchPoll({ now = new Date() } = {}) {
  const from = await loadCursor();
  const to = now;

  console.log(
    `OrderFlow despatch poll: from=${from.toISOString()} to=${to.toISOString()}`,
  );

  const despatches = await getRecentDespatches({ from, to });
  console.log(`OrderFlow despatch poll: received ${despatches.length} shipments`);

  const results = [];
  for (const shipment of despatches) {
    const shipmentRef = shipment.reference;
    const orderName =
      shipment.originatingOrderReference || shipment.orderReference;

    if (!shipmentRef || !orderName) {
      results.push({ shipment, skipped: true, reason: "missing reference" });
      continue;
    }

    const already = await prisma.fulfilledShipment.findUnique({
      where: { shipmentExternalReference: shipmentRef },
    });
    if (already) {
      results.push({ shipmentRef, skipped: true, reason: "already fulfilled" });
      continue;
    }

    try {
      const productSkus = shipment.orderLines.map((line) => line.productReference);
      const fulfillResult = await fulfillShopifyOrder({
        shopifyOrderName: orderName,
        trackingNumber: shipment.despatchReference,
        trackingUrl: shipment.trackingUrl,
        courier: shipment.carrier || shipment.courier,
        productSkus,
      });

      if (fulfillResult.ok) {
        await prisma.fulfilledShipment.create({
          data: {
            shipmentExternalReference: shipmentRef,
            shopifyOrderName: fulfillResult.shopifyOrderName,
            shopifyFulfillmentId: fulfillResult.fulfillmentId,
            trackingNumber: shipment.despatchReference || null,
            courier: shipment.carrier || null,
          },
        });
        results.push({
          shipmentRef,
          ok: true,
          shopifyOrderName: fulfillResult.shopifyOrderName,
        });
      } else {
        console.warn(
          `OrderFlow despatch poll skip: shipment=${shipmentRef} reason=${fulfillResult.reason}`,
        );
        results.push({ shipmentRef, skipped: true, reason: fulfillResult.reason });
      }
    } catch (error) {
      console.error(
        `OrderFlow despatch poll failure for shipment=${shipmentRef} order=${orderName}:`,
        error,
      );
      results.push({
        shipmentRef,
        failed: true,
        error: error?.message || String(error),
      });
    }
  }

  const maxCompleted = despatches
    .map((s) => parseDespatchedDate(s.completed))
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const nextCursor = maxCompleted && maxCompleted > from ? maxCompleted : to;
  await saveCursor(nextCursor);

  return {
    from,
    to,
    nextCursor,
    received: despatches.length,
    fulfilled: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => r.failed).length,
    results,
  };
}
