import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { MemberParam, Range, RateDomain, Shape, Value, ValueType } from "./common";
export declare const protobufPackage = "orrery.plugin.v1";
export interface PluginManifest {
    /** "wave" — stable asset name; bind target is "<asset>.v<version>" */
    asset: string;
    /** major version = contract-compatibility boundary */
    version: number;
    kind: PluginManifest_Kind;
    humanLabel: string;
    /** "plugin.v1" */
    schemaVersion: string;
    /** bound by PluginBinding.inputs */
    inputs: Port[];
    /** set  by PluginBinding.params */
    params: Param[];
    /** where results go (emitter / bus / per-member) */
    outputs: Port[];
    /** per-member context the runtime supplies automatically (choreographies): */
    memberNeeds: MemberParam[];
    rateDomain: RateDomain;
    /** execution contract — what the host must provide and the simulator can prove: */
    requiresHostTick: boolean;
    /**
     * cooldowns, random intervals): the host MUST
     * drive it on a tick even with no input packets.
     * false = purely input/frame-reactive.
     */
    determinism: PluginManifest_Determinism;
    stateModel: PluginManifest_StateModel;
}
export declare enum PluginManifest_Determinism {
    /** DETERMINISM_UNSPECIFIED - → REPLAYABLE (the default obligation) */
    DETERMINISM_UNSPECIFIED = 0,
    /** REPLAYABLE - same seed + input trace → same outputs; golden-traceable */
    REPLAYABLE = 1,
    /** REALTIME_ONLY - depends on real timing (live audio callback); simulator */
    REALTIME_ONLY = 2,
    /** EXTERNAL_IO - can check invariants but not exact outputs */
    EXTERNAL_IO = 3,
    UNRECOGNIZED = -1
}
export declare function pluginManifest_DeterminismFromJSON(object: any): PluginManifest_Determinism;
export declare function pluginManifest_DeterminismToJSON(object: PluginManifest_Determinism): string;
export declare enum PluginManifest_StateModel {
    /** STATE_MODEL_UNSPECIFIED - → OPAQUE */
    STATE_MODEL_UNSPECIFIED = 0,
    /** STATELESS - pure f(inputs, member ctx) — trivially reloadable */
    STATELESS = 1,
    /** SNAPSHOTTABLE - host can snapshot/restore state (reload/replay-resume) */
    SNAPSHOTTABLE = 2,
    /** OPAQUE - state exists but can't be captured — reload = reinit + ramp */
    OPAQUE = 3,
    UNRECOGNIZED = -1
}
export declare function pluginManifest_StateModelFromJSON(object: any): PluginManifest_StateModel;
export declare function pluginManifest_StateModelToJSON(object: PluginManifest_StateModel): string;
export declare enum PluginManifest_Kind {
    KIND_UNSPECIFIED = 0,
    /** SCENE_RASTER - raster scene → screen emitter (+ optional abstract field) */
    SCENE_RASTER = 1,
    /** CHOREOGRAPHY - per-member render (the wave) → emitter-group members */
    CHOREOGRAPHY = 2,
    /** VECTOR_LASER - field/frame → ILDA vector path */
    VECTOR_LASER = 3,
    /** FX - audio-plane FX choreography */
    FX = 4,
    /** GENERATOR - emits seq.* /control back onto the bus */
    GENERATOR = 5,
    UNRECOGNIZED = -1
}
export declare function pluginManifest_KindFromJSON(object: any): PluginManifest_Kind;
export declare function pluginManifest_KindToJSON(object: PluginManifest_Kind): string;
export interface Port {
    /** local port name = the binding key */
    name: string;
    valueType: ValueType;
    /** STATE | EVENT */
    shape: Shape;
    unit: string;
    range?: Range | undefined;
    /** input: must be bound; output: always produced */
    required: boolean;
    /** outputs only: */
    dest: Port_Dest;
    /** what kind of thing this output is */
    media: Port_Media;
    /** dest=BUS → published path (may use ${group}) */
    busPath?: string | undefined;
}
export declare enum Port_Dest {
    DEST_UNSPECIFIED = 0,
    EMITTER = 1,
    BUS = 2,
    MEMBER = 3,
    UNRECOGNIZED = -1
}
export declare function port_DestFromJSON(object: any): Port_Dest;
export declare function port_DestToJSON(object: Port_Dest): string;
export declare enum Port_Media {
    MEDIA_UNSPECIFIED = 0,
    RASTER_FRAME = 1,
    ABSTRACT_FIELD = 2,
    VECTOR_PATH = 3,
    PER_MEMBER_VALUE = 4,
    SIGNAL = 5,
    UNRECOGNIZED = -1
}
export declare function port_MediaFromJSON(object: any): Port_Media;
export declare function port_MediaToJSON(object: Port_Media): string;
export interface Param {
    name: string;
    valueType: ValueType;
    /** absent default → required */
    default?: Value | undefined;
    range?: Range | undefined;
    /** for enumerated params */
    enumValues: string[];
}
export declare const PluginManifest: MessageFns<PluginManifest>;
export declare const Port: MessageFns<Port>;
export declare const Param: MessageFns<Param>;
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
