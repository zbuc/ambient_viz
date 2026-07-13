//! Color: perceptual 8/16-bit input -> linear 16-bit light.
//!
//! Everything downstream of here (the dimmer, the encoder) works in LINEAR light.
//! Gamma is applied once, on the way in.

/// Perceptual 8-bit-per-channel color, the usual thing a palette or an animation
/// hands you.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Rgb8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Linear light, 16 bits per channel. The dimmer's input.
///
/// 16 bits is not vanity: the SK9822's hybrid dimming (see [`crate::dim`]) can
/// resolve ~13 bits, so an 8-bit pipeline would throw away the headroom that
/// keeps a slow fade smooth at the bottom of its range.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Rgb16 {
    pub r: u16,
    pub g: u16,
    pub b: u16,
}

impl Rgb16 {
    pub const BLACK: Self = Self { r: 0, g: 0, b: 0 };

    /// The brightest channel — what the dimmer picks the global current from.
    pub fn peak(&self) -> u16 {
        self.r.max(self.g).max(self.b)
    }

    /// Scale all channels by `num/den` in linear light (a master/master-fade level).
    pub fn scale(&self, num: u32, den: u32) -> Self {
        let s = |c: u16| ((c as u32 * num) / den).min(u16::MAX as u32) as u16;
        Self {
            r: s(self.r),
            g: s(self.g),
            b: s(self.b),
        }
    }
}

/// A gamma curve as a 256-entry lookup table into linear 16-bit light.
///
/// Precomputed literals rather than `powf` at init, so this crate needs no libm
/// and no allocator, and the table costs 512 bytes of flash.
pub struct Gamma {
    lut: &'static [u16; 256],
}

impl Gamma {
    /// gamma 2.2 — the conventional display curve; a good default.
    pub const G22: Self = Self { lut: &GAMMA_2_2 };
    /// gamma 2.8 — steeper; more of the input range spent down in the dark end,
    /// which is where slow ambient fades live. Try both on the bench.
    pub const G28: Self = Self { lut: &GAMMA_2_8 };

    /// 8-bit perceptual -> 16-bit linear.
    pub fn map_u8(&self, v: u8) -> u16 {
        self.lut[v as usize]
    }

    /// 16-bit perceptual -> 16-bit linear, interpolating between table entries.
    ///
    /// This is the one a long fade wants: an 8-bit fade input would step through
    /// only 256 positions no matter how good the dimmer underneath it is.
    pub fn map_u16(&self, v: u16) -> u16 {
        let hi = (v >> 8) as usize;
        let frac = (v & 0xff) as u32;
        let a = self.lut[hi] as u32;
        let b = self.lut[(hi + 1).min(255)] as u32;
        (a + (((b - a) * frac) >> 8)) as u16
    }

    pub fn map(&self, c: Rgb8) -> Rgb16 {
        Rgb16 {
            r: self.map_u8(c.r),
            g: self.map_u8(c.g),
            b: self.map_u8(c.b),
        }
    }
}

#[rustfmt::skip]
static GAMMA_2_2: [u16; 256] = [
         0,      0,      2,      4,      7,     11,     17,     24,
        32,     42,     53,     65,     79,     94,    111,    129,
       148,    169,    192,    216,    242,    270,    299,    330,
       362,    396,    432,    469,    508,    549,    591,    635,
       681,    729,    779,    830,    883,    938,    995,   1053,
      1113,   1175,   1239,   1305,   1373,   1443,   1514,   1587,
      1663,   1740,   1819,   1900,   1983,   2068,   2155,   2243,
      2334,   2427,   2521,   2618,   2717,   2817,   2920,   3024,
      3131,   3240,   3350,   3463,   3578,   3694,   3813,   3934,
      4057,   4182,   4309,   4438,   4570,   4703,   4838,   4976,
      5115,   5257,   5401,   5547,   5695,   5845,   5998,   6152,
      6309,   6468,   6629,   6792,   6957,   7124,   7294,   7466,
      7640,   7816,   7994,   8175,   8358,   8543,   8730,   8919,
      9111,   9305,   9501,   9699,   9900,  10102,  10307,  10515,
     10724,  10936,  11150,  11366,  11585,  11806,  12029,  12254,
     12482,  12712,  12944,  13179,  13416,  13655,  13896,  14140,
     14386,  14635,  14885,  15138,  15394,  15652,  15912,  16174,
     16439,  16706,  16975,  17247,  17521,  17798,  18077,  18358,
     18642,  18928,  19216,  19507,  19800,  20095,  20393,  20694,
     20996,  21301,  21609,  21919,  22231,  22546,  22863,  23182,
     23504,  23829,  24156,  24485,  24817,  25151,  25487,  25826,
     26168,  26512,  26858,  27207,  27558,  27912,  28268,  28627,
     28988,  29351,  29717,  30086,  30457,  30830,  31206,  31585,
     31966,  32349,  32735,  33124,  33514,  33908,  34304,  34702,
     35103,  35507,  35913,  36321,  36732,  37146,  37562,  37981,
     38402,  38825,  39252,  39680,  40112,  40546,  40982,  41421,
     41862,  42306,  42753,  43202,  43654,  44108,  44565,  45025,
     45487,  45951,  46418,  46888,  47360,  47835,  48313,  48793,
     49275,  49761,  50249,  50739,  51232,  51728,  52226,  52727,
     53230,  53736,  54245,  54756,  55270,  55787,  56306,  56828,
     57352,  57879,  58409,  58941,  59476,  60014,  60554,  61097,
     61642,  62190,  62741,  63295,  63851,  64410,  64971,  65535,
];

#[rustfmt::skip]
static GAMMA_2_8: [u16; 256] = [
         0,      0,      0,      0,      1,      1,      2,      3,
         4,      6,      8,     10,     13,     16,     19,     24,
        28,     33,     39,     46,     53,     60,     69,     78,
        88,     98,    110,    122,    135,    149,    164,    179,
       196,    214,    232,    252,    273,    295,    317,    341,
       366,    393,    420,    449,    478,    510,    542,    575,
       610,    647,    684,    723,    764,    806,    849,    894,
       940,    988,   1037,   1088,   1140,   1194,   1250,   1307,
      1366,   1427,   1489,   1553,   1619,   1686,   1756,   1827,
      1900,   1975,   2051,   2130,   2210,   2293,   2377,   2463,
      2552,   2642,   2734,   2829,   2925,   3024,   3124,   3227,
      3332,   3439,   3548,   3660,   3774,   3890,   4008,   4128,
      4251,   4376,   4504,   4634,   4766,   4901,   5038,   5177,
      5319,   5464,   5611,   5760,   5912,   6067,   6224,   6384,
      6546,   6711,   6879,   7049,   7222,   7397,   7576,   7757,
      7941,   8128,   8317,   8509,   8704,   8902,   9103,   9307,
      9514,   9723,   9936,  10151,  10370,  10591,  10816,  11043,
     11274,  11507,  11744,  11984,  12227,  12473,  12722,  12975,
     13230,  13489,  13751,  14017,  14285,  14557,  14833,  15111,
     15393,  15678,  15967,  16259,  16554,  16853,  17155,  17461,
     17770,  18083,  18399,  18719,  19042,  19369,  19700,  20034,
     20372,  20713,  21058,  21407,  21759,  22115,  22475,  22838,
     23206,  23577,  23952,  24330,  24713,  25099,  25489,  25884,
     26282,  26683,  27089,  27499,  27913,  28330,  28752,  29178,
     29608,  30041,  30479,  30921,  31367,  31818,  32272,  32730,
     33193,  33660,  34131,  34606,  35085,  35569,  36057,  36549,
     37046,  37547,  38052,  38561,  39075,  39593,  40116,  40643,
     41175,  41711,  42251,  42796,  43346,  43899,  44458,  45021,
     45588,  46161,  46737,  47319,  47905,  48495,  49091,  49691,
     50295,  50905,  51519,  52138,  52761,  53390,  54023,  54661,
     55303,  55951,  56604,  57261,  57923,  58590,  59262,  59939,
     60621,  61308,  62000,  62697,  63399,  64106,  64818,  65535,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamma_endpoints_and_monotonicity() {
        for g in [Gamma::G22, Gamma::G28] {
            assert_eq!(g.map_u8(0), 0);
            assert_eq!(g.map_u8(255), 65535);
            let mut prev = 0;
            for v in 0..=255u8 {
                let x = g.map_u8(v);
                assert!(x >= prev, "gamma must be non-decreasing at {v}");
                prev = x;
            }
        }
    }

    #[test]
    fn map_u16_interpolates_and_agrees_with_map_u8() {
        let g = Gamma::G22;
        for v in 0..=255u8 {
            assert_eq!(g.map_u16((v as u16) << 8), g.map_u8(v));
        }
        let mut prev = 0;
        for v in 0..=65535u16 {
            let x = g.map_u16(v);
            assert!(x >= prev, "gamma16 must be non-decreasing at {v}");
            prev = x;
        }
    }

    #[test]
    fn gamma_28_is_darker_in_the_low_end() {
        // The whole reason to offer it: more resolution spent below mid-grey.
        assert!(Gamma::G28.map_u8(64) < Gamma::G22.map_u8(64));
    }
}
