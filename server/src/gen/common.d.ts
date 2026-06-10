import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
export declare const protobufPackage = "orrery.common.v1";
/** ── signal typing ─────────────────────────────────────────── */
export declare enum ValueType {
    VALUE_TYPE_UNSPECIFIED = 0,
    VALUE_TYPE_FLOAT = 1,
    VALUE_TYPE_INT = 2,
    VALUE_TYPE_BOOL = 3,
    VALUE_TYPE_TEXT = 4,
    VALUE_TYPE_VEC = 5,
    VALUE_TYPE_BLOB = 6,
    UNRECOGNIZED = -1
}
export declare function valueTypeFromJSON(object: any): ValueType;
export declare function valueTypeToJSON(object: ValueType): string;
export declare enum Shape {
    SHAPE_UNSPECIFIED = 0,
    /** SHAPE_STATE - latest-replaces */
    SHAPE_STATE = 1,
    /** SHAPE_EVENT - append-only, ordered */
    SHAPE_EVENT = 2,
    UNRECOGNIZED = -1
}
export declare function shapeFromJSON(object: any): Shape;
export declare function shapeToJSON(object: Shape): string;
/** ── rate domains (a node's / signal's tick rate) ──────────── */
export declare enum RateDomain {
    RATE_DOMAIN_UNSPECIFIED = 0,
    /** RATE_CONTROL - arrival-driven / async, low rate — NO tick. */
    RATE_CONTROL = 1,
    /** RATE_RENDER_FRAME - Activation semantics: ROUTER_IR.md → Execution semantics */
    RATE_RENDER_FRAME = 2,
    /** RATE_AUDIO_SAMPLE - sample-rate */
    RATE_AUDIO_SAMPLE = 3,
    /** RATE_MUSICAL - per musical subdivision; tick granularity is declared */
    RATE_MUSICAL = 4,
    UNRECOGNIZED = -1
}
export declare function rateDomainFromJSON(object: any): RateDomain;
export declare function rateDomainToJSON(object: RateDomain): string;
/** ── per-member context selector (render-plane groups) ─────── */
export declare enum MemberParam {
    MEMBER_PARAM_UNSPECIFIED = 0,
    MEMBER_INDEX = 1,
    MEMBER_COUNT = 2,
    MEMBER_LOGICAL = 3,
    MEMBER_POSITION = 4,
    UNRECOGNIZED = -1
}
export declare function memberParamFromJSON(object: any): MemberParam;
export declare function memberParamToJSON(object: MemberParam): string;
/** ── values ────────────────────────────────────────────────── */
export interface Value {
    number?: number | undefined;
    integer?: number | undefined;
    boolean?: boolean | undefined;
    text?: string | undefined;
    /** colors / positions / vectors */
    vec?: Vec | undefined;
    /** typed payload, schema-per-path */
    blob?: Uint8Array | undefined;
}
export interface Vec {
    elems: number[];
}
export interface Range {
    min: number;
    max: number;
}
export declare const Value: MessageFns<Value>;
export declare const Vec: MessageFns<Vec>;
export declare const Range: MessageFns<Range>;
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
