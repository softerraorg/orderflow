import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(
    `Received ${topic} webhook for ${shop}: inventory_item_id=${payload?.inventory_item_id} location_id=${payload?.location_id} available=${payload?.available}`,
  );

  return new Response();
};
