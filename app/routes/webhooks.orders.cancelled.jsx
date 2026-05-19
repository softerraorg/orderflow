import { authenticate } from "../shopify.server";
import { cancelOrder } from "../orderflow.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const result = await cancelOrder(payload);
    console.log(
      `OrderFlow order cancel ok for ${payload?.name}: ${result.status}`,
    );
  } catch (error) {
    console.error(
      `OrderFlow order cancel failed for ${payload?.name} (may already be despatched — handle as return):`,
      error,
    );
  }

  return new Response();
};
