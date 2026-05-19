import { authenticate } from "../shopify.server";
import { syncProduct } from "../orderflow.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const result = await syncProduct(payload);
    if (result.skipped) {
      console.log(
        `OrderFlow sync skipped for product ${payload?.id}: ${result.reason}`,
      );
    } else {
      console.log(
        `OrderFlow sync ok for product ${payload?.id}: ${result.status}`,
      );
    }
  } catch (error) {
    console.error(
      `OrderFlow sync failed for product ${payload?.id}:`,
      error,
    );
  }

  return new Response();
};
