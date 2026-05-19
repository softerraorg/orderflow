-- CreateTable
CREATE TABLE "PollState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "cursor" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FulfilledShipment" (
    "shipmentExternalReference" TEXT NOT NULL PRIMARY KEY,
    "shopifyOrderName" TEXT NOT NULL,
    "shopifyFulfillmentId" TEXT,
    "trackingNumber" TEXT,
    "courier" TEXT,
    "fulfilledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
