/**
 * One port per external channel (SMS/WhatsApp/Email) — three separate DI
 * tokens rather than one shared "channel registry" token, the same
 * one-token-per-concern shape `PAYMENT_PROVIDER`/`DELIVERY_PROVIDER`
 * already use. IN_APP has no adapter at all: creating the `Notification`
 * row already IS the delivery for that channel (docs/08-search-and-
 * notifications.md §14.2: "always created"), so `NotificationDispatchService`
 * never looks one up for it.
 */
export const SMS_CHANNEL_ADAPTER = Symbol('SMS_CHANNEL_ADAPTER');
export const WHATSAPP_CHANNEL_ADAPTER = Symbol('WHATSAPP_CHANNEL_ADAPTER');
export const EMAIL_CHANNEL_ADAPTER = Symbol('EMAIL_CHANNEL_ADAPTER');

export interface SendNotificationInput {
  /** E.164 phone number for SMS/WhatsApp, an email address for Email. */
  to: string;
  title: string;
  body: string;
}

export interface SendNotificationResult {
  providerMessageId: string;
}

/**
 * Deliberately provider-agnostic and synchronous-outcome-only — no
 * delivery-receipt webhook ingestion this phase (real SMS/WhatsApp/email
 * delivery receipts are a further integration each provider exposes
 * differently; "sent" vs "provider confirmed delivered" is a real gap,
 * flagged in PHASE_REPORTS.md, not silently assumed away). A failed send
 * throws — `NotificationDispatchService`/`NotificationRetryScheduler`
 * are the only callers, and they own retry/backoff/dead-letter, not the
 * adapter.
 */
export interface NotificationChannelAdapter {
  readonly name: string;
  send(input: SendNotificationInput): Promise<SendNotificationResult>;
}
