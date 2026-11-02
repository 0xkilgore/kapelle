Recorded fixtures shaped exactly like Resend's DOCUMENTED inbound contract (no account, no calls), 2026-10-15:
- email-received.json — `email.received` webhook event (metadata only): resend.com/docs/webhooks/emails/received
- receiving-get.json — `GET /emails/receiving/{id}`: resend.com/docs/api-reference/emails/retrieve-received-email
- attachments.json — `GET /emails/receiving/{id}/attachments`: resend.com/docs/api-reference/emails/list-received-email-attachments
Addresses/ids are synthetic; tests substitute the member's intake address into `to`. Signatures are computed in the test
with a synthetic whsec_ secret (Svix scheme); the Svix known-answer vector is asserted separately.
