CREATE TABLE "credentials" (
	"key" text PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"sequence" integer GENERATED ALWAYS AS IDENTITY (sequence name "events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_key" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"payload" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "events_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "idempotency" (
	"scope" text NOT NULL,
	"operation_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"claim_id" text NOT NULL,
	"target_keys" jsonb NOT NULL,
	"outcomes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "idempotency_scope_operation_key_pk" PRIMARY KEY("scope","operation_key"),
	CONSTRAINT "idempotency_claim_id_unique" UNIQUE("claim_id")
);
--> statement-breakpoint
CREATE TABLE "publication_deliveries" (
	"tenant_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"backend" text NOT NULL,
	"delivery_id" text NOT NULL,
	"account_id" text NOT NULL,
	CONSTRAINT "publication_deliveries_tenant_id_operation_key_backend_delivery_id_account_id_pk" PRIMARY KEY("tenant_id","operation_key","backend","delivery_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"tenant_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "publications_tenant_id_operation_key_pk" PRIMARY KEY("tenant_id","operation_key")
);
--> statement-breakpoint
CREATE TABLE "removal_reports" (
	"sequence" integer GENERATED ALWAYS AS IDENTITY (sequence name "removal_reports_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"event_key" text NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "removal_reports_tenant_id_event_key_pk" PRIMARY KEY("tenant_id","event_key"),
	CONSTRAINT "removal_reports_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE INDEX "events_state_sequence" ON "events" USING btree ("state","sequence");--> statement-breakpoint
CREATE INDEX "publication_delivery_lookup" ON "publication_deliveries" USING btree ("tenant_id","backend","delivery_id");--> statement-breakpoint
CREATE INDEX "removal_reports_publication" ON "removal_reports" USING btree ("tenant_id","operation_key","sequence");