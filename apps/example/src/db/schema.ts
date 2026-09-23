import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { DeliveryOutcome, PublishResult } from "@opencoredev/social-sdk";

const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => Buffer.from(value),
});

// Provider payloads are stored as JSON text: jsonb rejects strings containing U+0000.
const jsonText = customType<{ data: unknown; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value),
});

export const idempotency = pgTable(
  "idempotency",
  {
    scope: text("scope").notNull(),
    operationKey: text("operation_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    claimId: text("claim_id").notNull().unique(),
    targetKeys: jsonb("target_keys").$type<readonly string[]>().notNull(),
    outcomes: jsonb("outcomes").$type<Record<string, DeliveryOutcome>>().notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.scope, table.operationKey] })],
);

export const credentials = pgTable("credentials", {
  key: text("key").primaryKey(),
  revision: text("revision").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  iv: bytea("iv").notNull(),
  tag: bytea("tag").notNull(),
});

export const eventStates = ["pending", "quarantined", "processed"] as const;

export const events = pgTable(
  "events",
  {
    // Arrival order for the worker.
    sequence: integer("sequence").generatedAlwaysAsIdentity().notNull().unique(),
    eventKey: text("event_key").primaryKey(),
    state: text("state", { enum: eventStates }).notNull(),
    payload: jsonText("payload").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [index("events_state_sequence").on(table.state, table.sequence)],
);

export const publications = pgTable(
  "publications",
  {
    tenantId: text("tenant_id").notNull(),
    operationKey: text("operation_key").notNull(),
    result: jsonb("result").$type<PublishResult>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.operationKey] })],
);

export const publicationDeliveries = pgTable(
  "publication_deliveries",
  {
    tenantId: text("tenant_id").notNull(),
    operationKey: text("operation_key").notNull(),
    backend: text("backend").notNull(),
    deliveryId: text("delivery_id").notNull(),
    accountId: text("account_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.operationKey,
        table.backend,
        table.deliveryId,
        table.accountId,
      ],
    }),
    index("publication_delivery_lookup").on(table.tenantId, table.backend, table.deliveryId),
  ],
);

export const removalReports = pgTable(
  "removal_reports",
  {
    // Report order for a publication.
    sequence: integer("sequence").generatedAlwaysAsIdentity().notNull().unique(),
    tenantId: text("tenant_id").notNull(),
    operationKey: text("operation_key").notNull(),
    eventKey: text("event_key").notNull(),
    payload: jsonText("payload").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.eventKey] }),
    index("removal_reports_publication").on(table.tenantId, table.operationKey, table.sequence),
  ],
);
