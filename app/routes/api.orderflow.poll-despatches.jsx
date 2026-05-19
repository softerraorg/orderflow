import { runDespatchPoll } from "../orderflow-poll.server";

function unauthorized(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function checkSecret(request) {
  const expected = process.env.ORDERFLOW_POLL_SECRET;
  if (!expected) {
    return "ORDERFLOW_POLL_SECRET env var not set on server.";
  }
  const provided =
    request.headers.get("x-poll-secret") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== expected) return "Invalid or missing poll secret.";
  return null;
}

async function handle(request) {
  const authError = checkSecret(request);
  if (authError) return unauthorized(authError);

  try {
    const summary = await runDespatchPoll();
    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("OrderFlow despatch poll failed:", error);
    return new Response(
      JSON.stringify({ error: error?.message || String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

export const action = ({ request }) => handle(request);
export const loader = ({ request }) => handle(request);
