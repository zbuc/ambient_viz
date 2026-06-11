import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Range, Shape, Value, ValueType } from "./common";
export declare const protobufPackage = "orrery.manifest.v1";
export declare enum Semantic {
    /** SEMANTIC_UNSPECIFIED - fine for plain scalars */
    SEMANTIC_UNSPECIFIED = 0,
    SEMANTIC_COLOR_RGB = 1,
    /** SEMANTIC_POSITION_M - metres, in coord_frame */
    SEMANTIC_POSITION_M = 2,
    /** SEMANTIC_PHASE - cyclic 0..1 (pair with `cyclic`) */
    SEMANTIC_PHASE = 3,
    /** SEMANTIC_NORMALIZED_RATIO - 0..1 gain/amount */
    SEMANTIC_NORMALIZED_RATIO = 4,
    /** SEMANTIC_MIDI_7BIT - 0..127 quantized at the adapter */
    SEMANTIC_MIDI_7BIT = 5,
    UNRECOGNIZED = -1
}
export declare function semanticFromJSON(object: any): Semantic;
export declare function semanticToJSON(object: Semantic): string;
export declare enum CoordFrame {
    COORD_FRAME_UNSPECIFIED = 0,
    COORD_ROOM = 1,
    COORD_GROUP = 2,
    COORD_MEMBER = 3,
    COORD_SCREEN = 4,
    UNRECOGNIZED = -1
}
export declare function coordFrameFromJSON(object: any): CoordFrame;
export declare function coordFrameToJSON(object: CoordFrame): string;
/**
 * ValueType, Shape, Range → common.proto (orrery.common.v1).
 * Interpolation / OnStale are manifest-specific (stay here):
 */
export declare enum Interpolation {
    INTERPOLATION_UNSPECIFIED = 0,
    /** INTERPOLATION_STEP - hold — integer-count params (e.g. kicksPerTwist) */
    INTERPOLATION_STEP = 1,
    /** INTERPOLATION_LINEAR - smooth ramps (e.g. the bpm lane) — the usual default */
    INTERPOLATION_LINEAR = 2,
    UNRECOGNIZED = -1
}
export declare function interpolationFromJSON(object: any): Interpolation;
export declare function interpolationToJSON(object: Interpolation): string;
export declare enum OnStale {
    ON_STALE_UNSPECIFIED = 0,
    /** ON_STALE_HOLD - keep last value */
    ON_STALE_HOLD = 1,
    /** ON_STALE_NULL - mark unavailable */
    ON_STALE_NULL = 2,
    /** ON_STALE_DEFAULT - snap to `failsafe` */
    ON_STALE_DEFAULT = 3,
    /** ON_STALE_DECAY - ramp toward `failsafe` */
    ON_STALE_DECAY = 4,
    /** ON_STALE_FREEZE_ROUTE - freeze the downstream route */
    ON_STALE_FREEZE_ROUTE = 5,
    /** ON_STALE_FAIL_SAFE - assert the safety value (lasers / audio) */
    ON_STALE_FAIL_SAFE = 6,
    UNRECOGNIZED = -1
}
export declare function onStaleFromJSON(object: any): OnStale;
export declare function onStaleToJSON(object: OnStale): string;
/** queue full — every drop is COUNTED into _meta, never silent */
export declare enum OverflowPolicy {
    /** OVERFLOW_POLICY_UNSPECIFIED - → DROP_OLDEST */
    OVERFLOW_POLICY_UNSPECIFIED = 0,
    /** OVERFLOW_DROP_OLDEST - ring buffer (newest events are the show) */
    OVERFLOW_DROP_OLDEST = 1,
    OVERFLOW_DROP_NEWEST = 2,
    /** OVERFLOW_FAIL_ROUTE - treat the signal as stale → its on_stale path */
    OVERFLOW_FAIL_ROUTE = 3,
    UNRECOGNIZED = -1
}
export declare function overflowPolicyFromJSON(object: any): OverflowPolicy;
export declare function overflowPolicyToJSON(object: OverflowPolicy): string;
/** event older than max_event_age_ms at delivery time */
export declare enum LatePolicy {
    /** LATE_POLICY_UNSPECIFIED - → DROP */
    LATE_POLICY_UNSPECIFIED = 0,
    /** LATE_DROP - a 5 s burst of stale triggers after a reconnect */
    LATE_DROP = 1,
    /** LATE_FIRE - is worse than a visible, counted drop */
    LATE_FIRE = 2,
    /** LATE_COMPRESS_COUNT - deliver ONE event whose payload = dropped count */
    LATE_COMPRESS_COUNT = 3,
    UNRECOGNIZED = -1
}
export declare function latePolicyFromJSON(object: any): LatePolicy;
export declare function latePolicyToJSON(object: LatePolicy): string;
/** DDS/ROS QoS in miniature; transports honor per signal */
export declare enum Reliability {
    /** RELIABILITY_UNSPECIFIED - → BEST_EFFORT */
    RELIABILITY_UNSPECIFIED = 0,
    /** RELIABILITY_BEST_EFFORT - fire-and-forget; loss stays VISIBLE via */
    RELIABILITY_BEST_EFFORT = 1,
    /** RELIABILITY_ACKED - (boot_epoch, seq) gap counters → the inspector */
    RELIABILITY_ACKED = 2,
    UNRECOGNIZED = -1
}
export declare function reliabilityFromJSON(object: any): Reliability;
export declare function reliabilityToJSON(object: Reliability): string;
export declare enum Topology {
    TOPOLOGY_UNSPECIFIED = 0,
    TOPOLOGY_POINT = 1,
    TOPOLOGY_LINE = 2,
    TOPOLOGY_RING = 3,
    TOPOLOGY_GRID = 4,
    TOPOLOGY_GRAPH = 5,
    UNRECOGNIZED = -1
}
export declare function topologyFromJSON(object: any): Topology;
export declare function topologyToJSON(object: Topology): string;
export interface ModuleManifest {
    /** "manifest.v1" */
    schema: string;
    identity?: Identity | undefined;
    /** CLAIMED role name → resolved in ProjectPolicy */
    role: string;
    /** AUTHORITATIVE declaration of each published signal */
    publishes: SignalDecl[];
    /** EXPECTATIONS, not declarations — only path / */
    subscribes: SignalDecl[];
    /** render-plane emitter members only */
    group?: GroupMembership | undefined;
    /** render-plane emitter members only */
    geometry?: Geometry | undefined;
}
export interface Identity {
    /** "spiffe://pain-material.local/sensor/door-01" — durable, key/cert-backed */
    stableId: string;
    /** the `instance` segment in this module's paths ("door","ch3","led07") */
    instanceId: string;
    /** "Door distance sensor" */
    humanLabel: string;
    /** "vl53l1x-distance-node" */
    type: string;
    firmwareVersion: string;
    /** schema this module was built against (compat gate) */
    schemaVersion: string;
    /** enrolled-cert tie; present, unverified while OFF */
    certFingerprint?: string | undefined;
    /** signs THIS manifest (HMAC or signature); present, unverified while OFF */
    manifestSig?: Uint8Array | undefined;
}
export interface SignalDecl {
    /** concrete domain.instance.field, e.g. "sensor.door.distance_cm" */
    path: string;
    valueType: ValueType;
    /** STATE | EVENT */
    shape: Shape;
    /** from the PROJECT-PINNED token list ("cm", */
    unit: string;
    /**
     * "ratio", "hz", "") — free strings drift
     * (cm/centimeter/cms); registry rejects
     * tokens outside the project's list
     */
    range?: Range | undefined;
    nominalRateHz: number;
    maxRateHz: number;
    /** how the router fills between samples */
    interpolation: Interpolation;
    /** per-signal failure contract (ARCHITECTURE → Runtime contracts → Failure): */
    staleAfterMs: number;
    onStale: OnStale;
    /** value used by DEFAULT / FAIL_SAFE */
    failsafe?: Value | undefined;
    /** EVENT signals: receivers dedupe by (source.id, boot_epoch, seq)/dedupe_key */
    dedupe: boolean;
    /** value wraps range.max → range.min (phase-like). */
    cyclic: boolean;
    /**
     * Interpolation / Smooth / curves must wrap across
     * the seam, never traverse the interior (0.95→0.05
     * is a step of +0.10, not −0.90)
     */
    reliability: Reliability;
    /** REQUIRED when value_type = BLOB: the schema id the */
    blobSchema: string;
    /** EVENT queue contract — bounded, never SILENTLY lossy (bus.v1 → Event delivery): */
    maxQueue: number;
    /** 0 = no age bound; older-than → late_policy */
    maxEventAgeMs: number;
    overflowPolicy: OverflowPolicy;
    latePolicy: LatePolicy;
    /** REQUIRED when value_type = VEC — a vec3 */
    vecDim: number;
    /**
     * semantic metadata — manifest/tooling-side, NEVER in packets (keep Value lean).
     * vec_dim makes a position and a color the same shape; semantic tells them apart.
     */
    semantic: Semantic;
    /** for positional semantics: relative to what? */
    coordFrame: CoordFrame;
}
export interface GroupMembership {
    /** emitter-group id ("wave", "raster", "laser-array") */
    group: string;
    /** member index within the group (strip 3 of 4) */
    index: number;
    /** total members — for f(phase, index, count) local render */
    count?: number | undefined;
}
/** "position is not one number" — ARCHITECTURE → Runtime contracts → Group geometry. */
export interface Geometry {
    topology: Topology;
    /** physical, metres in room */
    positionM?: Vec3 | undefined;
    /** member's span on the group's normalized */
    logical: number[];
    /**
     * axes — LINE/RING: [begin, end];
     * GRID: [u0, v0, u1, v1]; POINT: [u, v]
     */
    orientation?: Vec3 | undefined;
    /** row-major transform; length disambiguates: */
    calibration: number[];
    /** 9 = 3×3 homography (2-D warp), 16 = 4×4 */
    latencyOffsetMs: number;
    /** group reference; schedulers lead it to match */
    colorProfile: string;
    /** 0..1 hard cap */
    brightnessLimit?: number | undefined;
    safe?: SafeEnvelope | undefined;
}
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}
/**
 * ENFORCED NODE-LOCAL, LAST IN THE CHAIN. The envelope is a property of the
 * device, applied after every bus-driven input — no packet at any priority can
 * exceed it. Upstream (router) clamping is an optimization, never the safety.
 */
export interface SafeEnvelope {
    /** 0..1 hard cap */
    maxBrightness?: number | undefined;
    /** laser scan-angle limits */
    scanMinDeg?: number | undefined;
    scanMaxDeg?: number | undefined;
    /** blank when outside envelope */
    requireBlanking?: boolean | undefined;
    /** photosensitivity guard */
    maxFlashHz?: number | undefined;
}
export interface ProjectPolicy {
    /** "policy.v1" */
    schema: string;
    /** installation name */
    project: string;
    /** name → priority (safety:1000 … idle:100) */
    authorityLadder: {
        [key: string]: number;
    };
    roles: Role[];
    /** enrolled-id → role binding (the allowlist) */
    allow: TrustedId[];
    /** the PROJECT defines groups; members only claim */
    groups: GroupDef[];
    /** staging state as LIVE CONFIG, runtime-visible */
    runtimeModes?: RuntimeModes | undefined;
}
export interface ProjectPolicy_AuthorityLadderEntry {
    key: string;
    value: number;
}
export interface GroupDef {
    /** id ("wave") */
    group: string;
    /** expected member count — registry validates claims */
    count: number;
}
/**
 * The enforcement-off matrix (bus.v1) as config, not doc convention. The
 * inspector BANNERS any show running a permissive mode — staged enforcement
 * must never *look* enforced.
 */
export interface RuntimeModes {
    /** OFF | WARN | ENFORCE (authorization checks) */
    auth: RuntimeModes_Mode;
    /** NONE | HMAC | MTLS */
    signature: RuntimeModes_Sig;
    /** OFF = last-writer-wins | WARN | ENFORCE (full ladder) */
    priority: RuntimeModes_Mode;
    /** OFF = local-only | WARN = offset-estimated | ENFORCE = required */
    timeSync: RuntimeModes_Mode;
}
/**
 * safety has NO field on purpose: SafeEnvelope enforcement is unconditional,
 * node-local, on from day one. There is no permissive mode to declare.
 */
export declare enum RuntimeModes_Mode {
    MODE_UNSPECIFIED = 0,
    OFF = 1,
    WARN = 2,
    ENFORCE = 3,
    UNRECOGNIZED = -1
}
export declare function runtimeModes_ModeFromJSON(object: any): RuntimeModes_Mode;
export declare function runtimeModes_ModeToJSON(object: RuntimeModes_Mode): string;
export declare enum RuntimeModes_Sig {
    SIG_UNSPECIFIED = 0,
    NONE = 1,
    HMAC = 2,
    MTLS = 3,
    UNRECOGNIZED = -1
}
export declare function runtimeModes_SigFromJSON(object: any): RuntimeModes_Sig;
export declare function runtimeModes_SigToJSON(object: RuntimeModes_Sig): string;
export interface Role {
    name: string;
    /** path globs; ${instance} expands to the module's instance_id */
    canPublish: string[];
    /** explicit denials (clock.* / safety.* / laser.* …) */
    cannotPublish: string[];
    canSubscribe: string[];
    /** ceiling this role may assert on a packet */
    maxPriority: number;
}
export interface TrustedId {
    /** spiffe://… */
    stableId: string;
    role: string;
    /** expected instance for this id */
    instanceId: string;
}
export declare const ModuleManifest: MessageFns<ModuleManifest>;
export declare const Identity: MessageFns<Identity>;
export declare const SignalDecl: MessageFns<SignalDecl>;
export declare const GroupMembership: MessageFns<GroupMembership>;
export declare const Geometry: MessageFns<Geometry>;
export declare const Vec3: MessageFns<Vec3>;
export declare const SafeEnvelope: MessageFns<SafeEnvelope>;
export declare const ProjectPolicy: MessageFns<ProjectPolicy>;
export declare const ProjectPolicy_AuthorityLadderEntry: MessageFns<ProjectPolicy_AuthorityLadderEntry>;
export declare const GroupDef: MessageFns<GroupDef>;
export declare const RuntimeModes: MessageFns<RuntimeModes>;
export declare const Role: MessageFns<Role>;
export declare const TrustedId: MessageFns<TrustedId>;
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
