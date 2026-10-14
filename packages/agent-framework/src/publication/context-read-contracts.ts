import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest, canonical } from '../content.js';
export const contextBytesHash = (bytes: string | Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const ref = z.string().min(1).max(256), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const contextPinSchema = z.object({ documentRef: ref, documentType: ref, contentVersion: z.number().int().positive(), contentHash: hash }).strict();
export type ContextPin = z.infer<typeof contextPinSchema>;
export const contextInputSchema = z.object({
    ...contextPinSchema.shape, authorityRef: ref, ownerId: ref, scopeRef: ref,
    purpose: z.enum(['INSTRUCTIONS', 'REFERENCE', 'WORKING_NOTE', 'OUTPUT']),
    provenance: z.object({ sourceRef: ref, producerId: ref, recordedAt: z.iso.datetime() }).strict(),
    supersedes: contextPinSchema.nullable(),
}).strict();
export const contextManifestSchema = z.object({
    contract: z.literal('kapelle/saved-context-manifest/v1'), ownerId: ref, scopeRef: ref,
    inputs: z.array(contextInputSchema).min(1).max(16),
}).strict().superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const input of value.inputs) {
        if (seen.has(input.documentRef) || input.ownerId !== value.ownerId || input.scopeRef !== value.scopeRef)
            ctx.addIssue({ code: 'custom', message: 'Duplicate or out-of-scope context input' });
        seen.add(input.documentRef);
        if (input.supersedes && (canonical(input.supersedes) === canonical(pinOf(input)) || input.supersedes.documentRef === input.documentRef && input.supersedes.contentVersion >= input.contentVersion))
            ctx.addIssue({ code: 'custom', message: 'Invalid supersession' });
    }
});
export type ContextManifest = z.infer<typeof contextManifestSchema>;
export type ContextInput = z.infer<typeof contextInputSchema>;
export function pinOf(value: ContextPin): ContextPin { return contextPinSchema.parse(Object.fromEntries(Object.keys(contextPinSchema.shape).map(key => [key, value[key as keyof ContextPin]]))); }
export const samePin = (a: ContextPin, b: ContextPin) => canonical(pinOf(a)) === canonical(pinOf(b));
export const manifestMarkdown = (manifest: ContextManifest) => '# Saved context manifest\n\n```json\n' + JSON.stringify(contextManifestSchema.parse(manifest), null, 2) + '\n```\n';
export function parseManifestMarkdown(text: string) {
    if (Buffer.byteLength(text) > 32768)
        throw Error('Manifest exceeds its byte limit');
    const match = /^# Saved context manifest\n\n```json\n([\s\S]+)\n```\n$/.exec(text);
    if (!match)
        throw Error('Unsupported context manifest representation');
    return contextManifestSchema.parse(JSON.parse(match[1]));
}
export const contextStatusSchema = z.enum(['RESOLVED', 'REVOKED', 'DENIED', 'MISSING', 'STALE', 'UNAVAILABLE', 'LIMIT_EXCEEDED']);
export type ContextStatus = z.infer<typeof contextStatusSchema>;
export type ReadFailure = {
    status: Exclude<ContextStatus, 'RESOLVED'>;
    reason: string;
};
export type ContextRead = ReadFailure | {
    status: 'RESOLVED';
    pin: ContextPin;
    ownerId: string;
    scopeRef: string;
    authorityRef: string;
    content: string;
    mimeType: 'text/markdown' | 'text/plain' | 'text/csv';
    provenance: ContextInput['provenance'];
};
export const resolvedSourceSchema = z.object({ status: z.literal('RESOLVED'), pin: contextPinSchema, ownerId: ref, scopeRef: ref, authorityRef: ref, content: z.string(), mimeType: z.string(), provenance: contextInputSchema.shape.provenance }).strict();
export interface ContextSourceReader {
    /** A host-installed reader, not a model-supplied path/URL. It must enforce its
     * own current ACL before returning bytes, even when the native grant exists. */
    read(input: {
        principalId: string;
        ownerId: string;
        scopeRef: string;
        authorityRef: string;
        pin: ContextPin;
        signal: AbortSignal;
    }): Promise<ContextRead>;
}
export const contextReceiptSchema = z.object({
    contract: z.literal('kapelle/context-receipt/v1'), ownerId: ref, scopeRef: ref, instanceId: ref,
    dispatchId: ref, inputHash: hash, manifest: contextPinSchema, requestedInputs: z.array(contextPinSchema).min(1).max(17),
    definition: z.object({ id: ref, version: ref, contentHash: hash }).strict(),
    task: z.object({ authorityRef: ref, taskRef: ref, commitmentHash: hash }).strict(),
    instructionsHash: hash, observedAt: z.iso.datetime(), status: z.enum(['READY', 'BLOCKED']),
    entries: z.array(z.object({ requested: contextInputSchema, status: contextStatusSchema, resolved: contextPinSchema.nullable(), reason: z.string().max(240) }).strict()).max(16),
    manifestStatus: contextStatusSchema, assignmentStatus: z.enum(['CURRENT', 'UNAVAILABLE']),
    omissions: z.array(z.object({ documentRef: ref, status: contextStatusSchema, reason: z.string().max(240) }).strict()).max(17),
    contextHash: hash.nullable(), receiptHash: hash,
}).strict();
export type ContextReceipt = z.infer<typeof contextReceiptSchema>;
export function sealReceipt(value: Omit<ContextReceipt, 'receiptHash'>): ContextReceipt { return contextReceiptSchema.parse({ ...value, receiptHash: digest(value) }); }
export function verifyReceipt(value: unknown): ContextReceipt {
    const receipt = contextReceiptSchema.parse(value), { receiptHash, ...body } = receipt;
    if (digest(body) !== receiptHash)
        throw Error('Context receipt integrity mismatch');
    const requested = new Map(receipt.requestedInputs.map(pin => [pin.documentRef, pin]));
    if (requested.size !== receipt.requestedInputs.length || !requested.has(receipt.manifest.documentRef) || !samePin(requested.get(receipt.manifest.documentRef)!, receipt.manifest))
        throw Error('Invalid receipt input inventory');
    const seen = new Set<string>();
    for (const entry of receipt.entries) {
        const input = entry.requested, pin = requested.get(input.documentRef);
        if (seen.has(input.documentRef) || input.documentRef === receipt.manifest.documentRef || !pin || !samePin(pin, input) || input.ownerId !== receipt.ownerId || input.scopeRef !== receipt.scopeRef)
            throw Error('Invalid receipt entry binding');
        seen.add(input.documentRef);
        if (entry.status === 'RESOLVED' ? (!entry.resolved || !samePin(input, entry.resolved)) : entry.resolved !== null)
            throw Error('Invalid receipt resolution');
    }
    const omitted = new Set<string>();
    for (const omission of receipt.omissions) {
        if (!requested.has(omission.documentRef) || omitted.has(omission.documentRef) || omission.status === 'RESOLVED')
            throw Error('Invalid receipt omission');
        omitted.add(omission.documentRef);
    }
    if (receipt.status === 'READY' && (receipt.contextHash === null || receipt.manifestStatus !== 'RESOLVED' || receipt.assignmentStatus !== 'CURRENT' || receipt.omissions.length || receipt.entries.length !== requested.size - 1 || receipt.entries.some(entry => entry.status !== 'RESOLVED')))
        throw Error('Incomplete ready context receipt');
    if (receipt.status === 'BLOCKED' && (receipt.contextHash !== null || !receipt.omissions.length))
        throw Error('Invalid blocked context receipt');
    return receipt;
}
