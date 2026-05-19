// Standalone probe that hits OrderFlow's /remoteorder/shipment/despatches.xml
// and prints both the raw XML and the unique carrier strings observed.
//
// Run:
//   node --env-file=.env scripts/inspect-despatches.mjs
//   node --env-file=.env scripts/inspect-despatches.mjs 90    # look back 90 days
//
// The number argument (optional) is days to look back. Defaults to 30.

const baseUrl = (
  process.env.ORDERFLOW_BASE_URL || "https://ifd.orderflow-wms.co.uk/web"
).replace(/\/$/, "");
const channel = process.env.ORDERFLOW_CHANNEL;
const user = process.env.ORDERFLOW_USER;
const password = process.env.ORDERFLOW_PASSWORD;

if (!channel || !user || !password) {
  console.error(
    "Missing env vars. Need ORDERFLOW_CHANNEL, ORDERFLOW_USER, ORDERFLOW_PASSWORD.",
  );
  process.exit(1);
}

const daysBack = Number(process.argv[2]) || 30;

function pad(n) {
  return String(n).padStart(2, "0");
}
function fmt(date) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

const to = new Date();
const from = new Date(to.getTime() - daysBack * 24 * 3600 * 1000);

const params = new URLSearchParams({
  from: fmt(from),
  to: fmt(to),
  includeOrderLines: "true",
});

const url = `${baseUrl}/remoteorder/shipment/despatches.xml?${params.toString()}`;

const encodedPassword = Buffer.from(password, "utf-8").toString("base64");
const basic = Buffer.from(`${user}:${password}`, "utf-8").toString("base64");

console.log(`POST ${url}`);
console.log(`from=${fmt(from)}  to=${fmt(to)}  channel=${channel}\n`);

const response = await fetch(url, {
  method: "GET",
  headers: {
    user,
    password: encodedPassword,
    channel,
    Authorization: `Basic ${basic}`,
  },
});

const body = await response.text();
console.log(`HTTP ${response.status}\n`);
console.log("=== RAW RESPONSE ===");
console.log(body);
console.log("====================\n");

const carriers = new Map();
const carrierRegex = /<carrier>([^<]*)<\/carrier>/g;
let m;
while ((m = carrierRegex.exec(body)) !== null) {
  const value = m[1].trim();
  carriers.set(value, (carriers.get(value) || 0) + 1);
}

const services = new Map();
const serviceRegex = /<service>([^<]*)<\/service>/g;
while ((m = serviceRegex.exec(body)) !== null) {
  const value = m[1].trim();
  services.set(value, (services.get(value) || 0) + 1);
}

const shipmentCount = (body.match(/<shipment[\s>]/g) || []).length;

console.log(`Total <shipment> entries: ${shipmentCount}`);
console.log("\nUnique <carrier> values and counts:");
if (carriers.size === 0) {
  console.log("  (none — endpoint returned no carrier elements)");
} else {
  for (const [name, count] of [...carriers.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${count.toString().padStart(4)}  ${JSON.stringify(name)}`);
  }
}

console.log("\nUnique <service> values and counts:");
if (services.size === 0) {
  console.log("  (none)");
} else {
  for (const [name, count] of [...services.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${count.toString().padStart(4)}  ${JSON.stringify(name)}`);
  }
}
