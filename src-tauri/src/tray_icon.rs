//! Tray icon rendered from the overall quota, so it can be read without
//! opening the panel. Pure RGBA drawing (no font / image crates):
//!
//! * `number`: coloured rounded square with the remaining % in a pixel font;
//! * `ring`:   a gauge ring filled to the remaining %.
//!
//! Colour follows the pet's mood thresholds; grey when offline.

pub const SIZE: u32 = 32;
const SS: u32 = 4; // supersampling per axis for anti-aliasing

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Level {
    Good,
    Warn,
    Bad,
    Offline,
}

impl Level {
    fn rgb(self) -> (u8, u8, u8) {
        match self {
            Level::Good => (48, 176, 88),
            Level::Warn => (232, 146, 12),
            Level::Bad => (224, 58, 52),
            Level::Offline => (128, 128, 134),
        }
    }
}

pub fn level_for(score: i32, offline: bool, working: i32, sleeping: i32) -> Level {
    if offline {
        Level::Offline
    } else if score > working {
        Level::Good
    } else if score >= sleeping {
        Level::Warn
    } else {
        Level::Bad
    }
}

/// 3x5 pixel digits, rows top to bottom, 3 bits each (MSB = left).
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b001, 0b001, 0b001],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];
const DASH: [u8; 5] = [0, 0, 0b111, 0, 0];

struct Canvas {
    px: Vec<u8>,
}

impl Canvas {
    fn new() -> Self {
        Self { px: vec![0; (SIZE * SIZE * 4) as usize] }
    }

    /// Alpha-composite `rgb` at `coverage` (0..1) over pixel (x, y).
    fn blend(&mut self, x: u32, y: u32, (r, g, b): (u8, u8, u8), coverage: f32) {
        if x >= SIZE || y >= SIZE || coverage <= 0.0 {
            return;
        }
        let i = ((y * SIZE + x) * 4) as usize;
        let a_src = coverage.min(1.0);
        let a_dst = self.px[i + 3] as f32 / 255.0;
        let a_out = a_src + a_dst * (1.0 - a_src);
        if a_out <= 0.0 {
            return;
        }
        for (k, c) in [r, g, b].into_iter().enumerate() {
            let src = c as f32;
            let dst = self.px[i + k] as f32;
            self.px[i + k] = ((src * a_src + dst * a_dst * (1.0 - a_src)) / a_out).round() as u8;
        }
        self.px[i + 3] = (a_out * 255.0).round() as u8;
    }

    /// Fill every pixel by its supersampled coverage of `inside(x, y)`.
    fn fill(&mut self, rgb: (u8, u8, u8), inside: impl Fn(f32, f32) -> bool) {
        let n = (SS * SS) as f32;
        for y in 0..SIZE {
            for x in 0..SIZE {
                let mut hits = 0u32;
                for sy in 0..SS {
                    for sx in 0..SS {
                        let fx = x as f32 + (sx as f32 + 0.5) / SS as f32;
                        let fy = y as f32 + (sy as f32 + 0.5) / SS as f32;
                        if inside(fx, fy) {
                            hits += 1;
                        }
                    }
                }
                self.blend(x, y, rgb, hits as f32 / n);
            }
        }
    }

    fn rect(&mut self, x: u32, y: u32, w: u32, h: u32, rgb: (u8, u8, u8)) {
        for yy in y..(y + h).min(SIZE) {
            for xx in x..(x + w).min(SIZE) {
                self.blend(xx, yy, rgb, 1.0);
            }
        }
    }
}

fn rounded_square(cx: f32, cy: f32, half: f32, radius: f32) -> impl Fn(f32, f32) -> bool {
    move |x, y| {
        let dx = ((x - cx).abs() - (half - radius)).max(0.0);
        let dy = ((y - cy).abs() - (half - radius)).max(0.0);
        dx * dx + dy * dy <= radius * radius
    }
}

fn draw_text(c: &mut Canvas, text: &str, rgb: (u8, u8, u8)) {
    let glyphs: Vec<&[u8; 5]> = text
        .chars()
        .map(|ch| match ch.to_digit(10) {
            Some(d) => &DIGITS[d as usize],
            None => &DASH,
        })
        .collect();
    let n = glyphs.len() as u32;
    // Largest scale that fits: 1 digit -> 5, 2 digits -> 4, 3 digits -> 3.
    let (scale, gap) = match n {
        0 | 1 => (5, 0),
        2 => (4, 3),
        _ => (3, 2),
    };
    let w = n * 3 * scale + n.saturating_sub(1) * gap;
    let h = 5 * scale;
    let x0 = (SIZE - w.min(SIZE)) / 2;
    let y0 = (SIZE - h) / 2;
    for (i, g) in glyphs.iter().enumerate() {
        let gx = x0 + i as u32 * (3 * scale + gap);
        for (row, bits) in g.iter().enumerate() {
            for col in 0..3u32 {
                if bits & (0b100 >> col) != 0 {
                    c.rect(gx + col * scale, y0 + row as u32 * scale, scale, scale, rgb);
                }
            }
        }
    }
}

/// RGBA pixels (SIZE x SIZE) for the given style, or None for the app icon.
pub fn render(style: &str, score: Option<i32>, level: Level) -> Option<Vec<u8>> {
    let mut c = Canvas::new();
    let color = level.rgb();
    let half = SIZE as f32 / 2.0;
    match style {
        "number" => {
            c.fill(color, rounded_square(half, half, half, 7.0));
            let text = match score {
                Some(s) if level != Level::Offline => s.clamp(0, 100).to_string(),
                _ => "-".to_string(),
            };
            draw_text(&mut c, &text, (255, 255, 255));
        }
        "ring" => {
            let (outer, inner) = (half - 1.0, half - 7.5);
            let frac = score.map(|s| s.clamp(0, 100) as f32 / 100.0).unwrap_or(0.0);
            let in_ring = move |x: f32, y: f32| {
                let d = ((x - half).powi(2) + (y - half).powi(2)).sqrt();
                d <= outer && d >= inner
            };
            c.fill((150, 150, 156), |x, y| in_ring(x, y));
            // Dim the track so the filled arc stands out.
            for a in c.px.chunks_mut(4) {
                a[3] = (a[3] as f32 * 0.45) as u8;
            }
            c.fill(color, move |x, y| {
                if !in_ring(x, y) {
                    return false;
                }
                // Clockwise from 12 o'clock, 0..1
                let ang = (x - half).atan2(half - y);
                let t = if ang < 0.0 { ang + std::f32::consts::TAU } else { ang } / std::f32::consts::TAU;
                t <= frac
            });
            c.fill(color, rounded_square(half, half, 3.5, 3.5));
        }
        _ => return None,
    }
    Some(c.px)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha(px: &[u8], x: u32, y: u32) -> u8 {
        px[((y * SIZE + x) * 4 + 3) as usize]
    }

    #[test]
    fn number_icon_has_opaque_body_and_white_digits() {
        let px = render("number", Some(74), Level::Good).unwrap();
        assert_eq!(px.len(), (SIZE * SIZE * 4) as usize);
        assert_eq!(alpha(&px, 16, 2), 255); // inside the square
        assert!(alpha(&px, 0, 0) < 80); // rounded corner
        // First stroke of "7" (top-left of the text block) is white.
        let i = ((6 * SIZE + 3) * 4) as usize;
        assert_eq!(&px[i..i + 3], &[255, 255, 255]);
    }

    #[test]
    fn ring_fills_proportionally() {
        let px = render("ring", Some(30), Level::Warn).unwrap();
        let col = |x: u32, y: u32| {
            let i = ((y * SIZE + x) * 4) as usize;
            (px[i], px[i + 1], px[i + 2])
        };
        assert_eq!(col(27, 16), Level::Warn.rgb()); // 3 o'clock: inside 30%
        assert_ne!(col(4, 16), Level::Warn.rgb()); // 9 o'clock: track only
    }

    #[test]
    fn icon_style_uses_app_icon() {
        assert!(render("icon", Some(50), Level::Good).is_none());
    }

    #[test]
    fn levels_follow_thresholds() {
        assert_eq!(level_for(80, false, 70, 20), Level::Good);
        assert_eq!(level_for(70, false, 70, 20), Level::Warn);
        assert_eq!(level_for(19, false, 70, 20), Level::Bad);
        assert_eq!(level_for(90, true, 70, 20), Level::Offline);
    }
}
