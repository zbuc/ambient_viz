import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Value } from "./common";
export declare const protobufPackage = "orrery.bus.v1";
export interface Source {
    /** "spiffe://pain-material.local/sensor/door-01" */
    sourceId: string;
    /** monotonic per source WITHIN one boot_epoch — */
    seq: number;
    /** ordering + dedup even with enforcement OFF */
    sig?: Uint8Array | undefined;
    /** enrolled-cert tie; ignored while OFF */
    certFingerprint?: string | undefined;
    /** increments (persisted counter) or re-randomizes */
    bootEpoch: number;
}
/**
 * A timestamp tagged with its timebase. Domains are NOT interchangeable;
 * cross-domain conversion is an explicit (initially no-op) step.
 */
export interface TimePoint {
    audioSample?: TimePoint_AudioSample | undefined;
    musical?: TimePoint_Musical | undefined;
    monotonic?: TimePoint_Monotonic | undefined;
    wall?: TimePoint_Wall | undefined;
    renderFrame?: TimePoint_RenderFrame | undefined;
}
export interface TimePoint_AudioSample {
    device: string;
    sample: number;
    sampleRate: number;
}
export interface TimePoint_Musical {
    beat: number;
    bar?: number | undefined;
    tempo?: number | undefined;
}
export interface TimePoint_Monotonic {
    device: string;
    nanos: number;
}
export interface TimePoint_Wall {
    unixNanos: number;
}
export interface TimePoint_RenderFrame {
    group: string;
    frame: number;
}
export interface SignalPacket {
    /** envelope — on every packet */
    schema: string;
    source?: Source | undefined;
    /** when this packet's content is timestamped */
    time?: TimePoint | undefined;
    /** authority-ladder value; resolver picks highest live writer per sink */
    priority: number;
    /** latest value replaces previous */
    state?: State | undefined;
    /** append-only, ordered, never collapsed/dropped */
    event?: Event | undefined;
    /** atomic group, one execution time */
    bundle?: Bundle | undefined;
}
export interface State {
    path: string;
    value?: Value | undefined;
    /** explicit staleness horizon; else manifest stale_after_ms */
    validUntil?: TimePoint | undefined;
    /** writer relinquishes this path NOW (sACN "stream */
    release: boolean;
}
export interface Event {
    path: string;
    payload?: Value | undefined;
    /** dedupe replays by (source.id, seq) or this */
    dedupeKey?: string | undefined;
    /** single scheduled event ("fire at beat 32.0") */
    targetTime?: TimePoint | undefined;
}
export interface Bundle {
    /** applied together; inherit the parent SignalPacket's source/time/priority */
    items: Bundle_Item[];
    targetTime?: TimePoint | undefined;
    /** true = apply all at target_time, or none */
    atomic: boolean;
}
export interface Bundle_Item {
    state?: State | undefined;
    event?: Event | undefined;
}
export declare const Source: MessageFns<Source>;
export declare const TimePoint: MessageFns<TimePoint>;
export declare const TimePoint_AudioSample: MessageFns<TimePoint_AudioSample>;
export declare const TimePoint_Musical: MessageFns<TimePoint_Musical>;
export declare const TimePoint_Monotonic: MessageFns<TimePoint_Monotonic>;
export declare const TimePoint_Wall: MessageFns<TimePoint_Wall>;
export declare const TimePoint_RenderFrame: MessageFns<TimePoint_RenderFrame>;
export declare const SignalPacket: MessageFns<SignalPacket>;
export declare const State: MessageFns<State>;
export declare const Event: MessageFns<Event>;
export declare const Bundle: MessageFns<Bundle>;
export declare const Bundle_Item: MessageFns<Bundle_Item>;
type Builtin = Date | Function | Uint8Array | string | number | boolean | undefined;
export type DeepPartial<T> = T extends Builtin ? T : T extends globalThis.Array<infer U> ? globalThis.Array<DeepPartial<U>> : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>> : T extends {} ? {
    [K in keyof T]?: DeepPartial<T[K]>;
} : Partial<T>;
type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin ? P : P & {
    [K in keyof P]: Exact<P[K], I[K]>;
} & {
    [K in Exclude<keyof I, KeysOfUnion<P>>]: never;
};
export interface MessageFns<T> {
    encode(message: T, writer?: BinaryWriter): BinaryWriter;
    decode(input: BinaryReader | Uint8Array, length?: number): T;
    fromJSON(object: any): T;
    toJSON(message: T): unknown;
    create<I extends Exact<DeepPartial<T>, I>>(base?: I): T;
    fromPartial<I extends Exact<DeepPartial<T>, I>>(object: I): T;
}
export {};
