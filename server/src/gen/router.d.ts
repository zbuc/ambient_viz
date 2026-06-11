import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { MemberParam, RateDomain, Value } from "./common";
export declare const protobufPackage = "orrery.router.v1";
export interface RouterGraph {
    /** "router.v1" */
    schema: string;
    /** main control-plane DAG */
    nodes: Node[];
    /** per-group / per-wildcard-match subgraphs */
    reps: Replicated[];
    wildcardPolicy?: WildcardPolicy | undefined;
    /** crossfade STATE outputs on reload (anti-discontinuity). */
    reloadRampMs?: number | undefined;
}
export interface Node {
    /** unique within its (sub)graph */
    id: string;
    rateDomain: RateDomain;
    input?: Input | undefined;
    const?: Const | undefined;
    curve?: Curve | undefined;
    scale?: Scale | undefined;
    /** HOLDS STATE (filter memory) */
    smooth?: Smooth | undefined;
    gate?: Gate | undefined;
    /** blend */
    combine?: Combine | undefined;
    /** fallback / pick */
    select?: Select | undefined;
    /** HOLDS STATE — the only legal way to make a cycle */
    delay?: Delay | undefined;
    /** Replicated-only: this instance's params */
    member?: Member | undefined;
    /** writer to a sink */
    output?: Output | undefined;
    /** HOLDS STATE — EVENT/STATE → STATE (follower) */
    envelope?: Envelope | undefined;
    /** HOLDS STATE (arm flag) — STATE → EVENT (edge detect) */
    trigger?: Trigger | undefined;
    /** HOLDS STATE — EVENT → STATE (hold/toggle/count) */
    latch?: Latch | undefined;
    /** pure — signal-parameterized (value-lo)/(hi-lo) */
    normalize?: Normalize | undefined;
}
/** ── sources ── */
export interface Input {
    /** bus SignalPath; may be a wildcard (REDUCE) feeding a Combine/Select */
    path: string;
    /** true → emits the matched set for a downstream reducer */
    wildcardReduce: boolean;
}
export interface Const {
    value?: Value | undefined;
}
/** valid only inside a Replicated subgraph */
export interface Member {
    /** MEMBER_INDEX / COUNT / LOGICAL / POSITION */
    which: MemberParam;
}
/** ── pure scalar/transfer ops ── */
export interface Curve {
    input: string;
    /** LINEAR | EASE_IN_QUAD | EASE_OUT_QUAD | EASE_IN_OUT | STEP | LUT */
    kind: Curve_Kind;
    /** when kind = LUT: N equally-spaced points over */
    lut: number[];
    /** [in_min, in_max], linear between entries */
    inMin: number;
    inMax: number;
    outMin: number;
    outMax: number;
    clamp: boolean;
}
export declare enum Curve_Kind {
    KIND_UNSPECIFIED = 0,
    LINEAR = 1,
    EASE_IN_QUAD = 2,
    EASE_OUT_QUAD = 3,
    EASE_IN_OUT = 4,
    STEP = 5,
    LUT = 6,
    UNRECOGNIZED = -1
}
export declare function curve_KindFromJSON(object: any): Curve_Kind;
export declare function curve_KindToJSON(object: Curve_Kind): string;
export interface Scale {
    input: string;
    mul: number;
    add: number;
}
/** (value − lo) / (hi − lo), clamped 0..1 */
export interface Normalize {
    input: string;
    lo: string;
    /** NODE IDS, not constants — the endpoints are */
    hi: string;
    /**
     * live signals. This is how LEARNED CALIBRATION
     * (the empty-room distance_far_cm) parameterizes
     * a graph; Curve's static in_min/in_max can't.
     */
    invert: boolean;
}
export interface Gate {
    input: string;
    control: string;
    threshold: number;
    mode: Gate_Mode;
    blockedValue?: Value | undefined;
}
export declare enum Gate_Mode {
    MODE_UNSPECIFIED = 0,
    ABOVE = 1,
    BELOW = 2,
    UNRECOGNIZED = -1
}
export declare function gate_ModeFromJSON(object: any): Gate_Mode;
export declare function gate_ModeToJSON(object: Gate_Mode): string;
/** ── temporal (HOLD STATE) ── */
export interface Smooth {
    input: string;
    kind: Smooth_Kind;
    /** ONE_POLE — interpreted IN THIS NODE'S rate_domain */
    timeConstantMs: number;
    /** SLEW */
    slewPerS: number;
    /** ONE_EURO — cutoff at rest (lower = smoother/laggier when still) */
    minCutoffHz: number;
    /** ONE_EURO — speed coefficient (higher = snappier on fast moves) */
    beta: number;
}
export declare enum Smooth_Kind {
    KIND_UNSPECIFIED = 0,
    ONE_POLE = 1,
    SLEW = 2,
    ONE_EURO = 3,
    UNRECOGNIZED = -1
}
export declare function smooth_KindFromJSON(object: any): Smooth_Kind;
export declare function smooth_KindToJSON(object: Smooth_Kind): string;
export interface Delay {
    input: string;
    frames: number;
}
/**
 * ── shape conversion (EVENT ↔ STATE; all HOLD STATE) ──
 * The explicit bridges between the two shapes — the reference visualizer's
 * envelope followers (bassPulse) and edge detectors (onset) live here, not
 * in hidden per-edge behavior.
 */
export interface Envelope {
    input: string;
    mode: Envelope_Mode;
    /** AR only; time params interpreted in */
    attackMs: number;
    /** this node's rate_domain (cf. Smooth) */
    releaseMs: number;
}
export declare enum Envelope_Mode {
    MODE_UNSPECIFIED = 0,
    /** PEAK_FOLLOW - instant attack, exponential release (bassPulse) */
    PEAK_FOLLOW = 1,
    AR = 2,
    UNRECOGNIZED = -1
}
export declare function envelope_ModeFromJSON(object: any): Envelope_Mode;
export declare function envelope_ModeToJSON(object: Envelope_Mode): string;
/** STATE in → EVENT out on threshold crossing */
export interface Trigger {
    input: string;
    threshold: number;
    /** value-domain band to re-arm (anti-chatter) */
    hysteresis: number;
    edge: Trigger_Edge;
}
export declare enum Trigger_Edge {
    EDGE_UNSPECIFIED = 0,
    RISING = 1,
    FALLING = 2,
    BOTH = 3,
    UNRECOGNIZED = -1
}
export declare function trigger_EdgeFromJSON(object: any): Trigger_Edge;
export declare function trigger_EdgeToJSON(object: Trigger_Edge): string;
/** EVENT in → STATE out */
export interface Latch {
    /** the event stream */
    input: string;
    /** optional second event stream → back to `idle` */
    reset?: string | undefined;
    mode: Latch_Mode;
    /** value before first event / after reset */
    idle?: Value | undefined;
}
export declare enum Latch_Mode {
    MODE_UNSPECIFIED = 0,
    /** HOLD_PAYLOAD - sample-and-hold the event payload */
    HOLD_PAYLOAD = 1,
    /** TOGGLE - bool flip per event */
    TOGGLE = 2,
    COUNT = 3,
    UNRECOGNIZED = -1
}
export declare function latch_ModeFromJSON(object: any): Latch_Mode;
export declare function latch_ModeToJSON(object: Latch_Mode): string;
/** ── multi-input ── */
export interface Combine {
    /** fixed order = deterministic for non-commutative modes */
    inputs: string[];
    mode: Combine_Mode;
    /** weights parallel to inputs for WEIGHTED */
    weights: number[];
}
export declare enum Combine_Mode {
    MODE_UNSPECIFIED = 0,
    SUM = 1,
    MUL = 2,
    MIN = 3,
    MAX = 4,
    AVG = 5,
    WEIGHTED = 6,
    UNRECOGNIZED = -1
}
export declare function combine_ModeFromJSON(object: any): Combine_Mode;
export declare function combine_ModeToJSON(object: Combine_Mode): string;
/** FALLBACK / pick */
export interface Select {
    inputs: string[];
    mode: Select_Mode;
    /** for BY_INDEX */
    indexInput?: string | undefined;
    /** anti-thrash when switching sources; interpreted in */
    hysteresisMs: number;
}
/**
 * this node's rate_domain (dt-aware in RATE_CONTROL,
 * same rule as Smooth's time params)
 */
export declare enum Select_Mode {
    MODE_UNSPECIFIED = 0,
    FIRST_LIVE = 1,
    HIGHEST_PRIORITY = 2,
    BY_INDEX = 3,
    UNRECOGNIZED = -1
}
export declare function select_ModeFromJSON(object: any): Select_Mode;
export declare function select_ModeToJSON(object: Select_Mode): string;
/** ── sink writer ── */
export interface Output {
    input: string;
    /** bus SignalPath; may use ${member}/${instance} inside a Replicated */
    target: string;
    /** STATE | EVENT */
    shape: Output_Shape;
    /** authority value; ≤ role.max_priority (checked vs ProjectPolicy) */
    priority: number;
    /** role asserting this write */
    authorityRole?: string | undefined;
}
export declare enum Output_Shape {
    SHAPE_UNSPECIFIED = 0,
    STATE = 1,
    EVENT = 2,
    UNRECOGNIZED = -1
}
export declare function output_ShapeFromJSON(object: any): Output_Shape;
export declare function output_ShapeToJSON(object: Output_Shape): string;
/** ── replication: groups & wildcard fan-out, unified ── */
export interface Replicated {
    /** GROUP:<id>  or  MATCH:<wildcard path> */
    over?: Replicated_Over | undefined;
    /** substitution var: "${member}" or "${instance}" */
    bind: string;
    rateDomain: RateDomain;
    /** simple shaping, expressed in nodes */
    graph?: NodeGraph | undefined;
    /** heavy/generative logic → a versioned plugin */
    plugin?: PluginBinding | undefined;
}
export interface Replicated_Over {
    group?: string | undefined;
    match?: string | undefined;
}
export interface NodeGraph {
    nodes: Node[];
    outputNode: string;
}
export interface PluginBinding {
    /** versioned plugin, e.g. "wave.v1" / "laser.edge_tracer.v1" */
    asset: string;
    /** plugin input name → node id or bus path */
    inputs: {
        [key: string]: string;
    };
    /** static params (scan_rate, intensity, …) */
    params: {
        [key: string]: number;
    };
}
export interface PluginBinding_InputsEntry {
    key: string;
    value: string;
}
export interface PluginBinding_ParamsEntry {
    key: string;
    value: number;
}
export interface WildcardPolicy {
    /** COMPILE_TIME (default) | DYNAMIC */
    expansion: WildcardPolicy_Expansion;
    requireTag: string[];
    /** e.g. ["debug","calibration"] */
    excludeTag: string[];
    /** IGNORE_UNTIL_RELOAD (default) | ADD */
    onNewMatch: WildcardPolicy_OnNewMatch;
    /** bounded fan-out guard */
    maxMatches: number;
    /** EXPECTED (default) | DISCOVERED — what the snapshot resolves against */
    matchAgainst: WildcardPolicy_MatchAgainst;
}
export declare enum WildcardPolicy_Expansion {
    EXPANSION_UNSPECIFIED = 0,
    COMPILE_TIME = 1,
    DYNAMIC = 2,
    UNRECOGNIZED = -1
}
export declare function wildcardPolicy_ExpansionFromJSON(object: any): WildcardPolicy_Expansion;
export declare function wildcardPolicy_ExpansionToJSON(object: WildcardPolicy_Expansion): string;
export declare enum WildcardPolicy_OnNewMatch {
    ON_NEW_MATCH_UNSPECIFIED = 0,
    IGNORE_UNTIL_RELOAD = 1,
    ADD = 2,
    UNRECOGNIZED = -1
}
export declare function wildcardPolicy_OnNewMatchFromJSON(object: any): WildcardPolicy_OnNewMatch;
export declare function wildcardPolicy_OnNewMatchToJSON(object: WildcardPolicy_OnNewMatch): string;
export declare enum WildcardPolicy_MatchAgainst {
    MATCH_AGAINST_UNSPECIFIED = 0,
    EXPECTED = 1,
    DISCOVERED = 2,
    UNRECOGNIZED = -1
}
export declare function wildcardPolicy_MatchAgainstFromJSON(object: any): WildcardPolicy_MatchAgainst;
export declare function wildcardPolicy_MatchAgainstToJSON(object: WildcardPolicy_MatchAgainst): string;
export declare const RouterGraph: MessageFns<RouterGraph>;
export declare const Node: MessageFns<Node>;
export declare const Input: MessageFns<Input>;
export declare const Const: MessageFns<Const>;
export declare const Member: MessageFns<Member>;
export declare const Curve: MessageFns<Curve>;
export declare const Scale: MessageFns<Scale>;
export declare const Normalize: MessageFns<Normalize>;
export declare const Gate: MessageFns<Gate>;
export declare const Smooth: MessageFns<Smooth>;
export declare const Delay: MessageFns<Delay>;
export declare const Envelope: MessageFns<Envelope>;
export declare const Trigger: MessageFns<Trigger>;
export declare const Latch: MessageFns<Latch>;
export declare const Combine: MessageFns<Combine>;
export declare const Select: MessageFns<Select>;
export declare const Output: MessageFns<Output>;
export declare const Replicated: MessageFns<Replicated>;
export declare const Replicated_Over: MessageFns<Replicated_Over>;
export declare const NodeGraph: MessageFns<NodeGraph>;
export declare const PluginBinding: MessageFns<PluginBinding>;
export declare const PluginBinding_InputsEntry: MessageFns<PluginBinding_InputsEntry>;
export declare const PluginBinding_ParamsEntry: MessageFns<PluginBinding_ParamsEntry>;
export declare const WildcardPolicy: MessageFns<WildcardPolicy>;
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
