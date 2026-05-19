import { authenticate } from "../shopify.server";
import { syncOrder } from "../orderflow.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const result = await syncOrder(payload);
    if (result.skipped) {
      console.log(
        `OrderFlow order sync skipped for ${payload?.name}: ${result.reason}`,
      );
    } else if (result.duplicate) {
      console.log(
        `OrderFlow order ${payload?.name} already imported (duplicate, ignored)`,
      );
    } else {
      console.log(
        `OrderFlow order sync ok for ${payload?.name}: ${result.status}`,
      );
    }
  } catch (error) {
    console.error(
      `OrderFlow order sync failed for ${payload?.name}:`,
      error,
    );
  }

  return new Response();
};
