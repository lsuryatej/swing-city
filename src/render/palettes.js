/**
 * PALETTES — the art direction, as data.
 *
 * The style lab's real finding was not that one look beat the others. It was
 * that the ones which worked all shared a CONTRAST STRATEGY and differed only
 * in hue: a saturated sky, a near-black city, and a hot rim on a near-black
 * figure. The ones that failed — including the original — put the buildings
 * and the character at nearly the same value, so the figure sank into the
 * skyline and no amount of texture rescued it.
 *
 * That makes this a system rather than a look, which is why it lives in a data
 * file. `noir` and `magicHour` are the same recipe in different keys; proving
 * that was the point of building six.
 *
 * ⚠️ Anything here that covers a large area may only ever CROSS-FADE between
 * palettes, never cut. See RENDER_DEFAULTS.beatAccents in canvas.js: a
 * large-area luminance change at beat rate is a photosensitivity hazard, and
 * the saturated reds below are the case the guidelines call out specifically.
 *
 * Fields:
 *   city      passed through to createCity/createSky
 *   render    merged into the renderer's options
 *   halftone  createHalftone args, plus alpha and the composite op
 *   grain     0..1 opacity of the paper noise, 0 to skip the pass entirely
 *   halo      colour of the contrast halo behind the figure, or null
 *             (a DARK halo on a dark sky raises local contrast; on a light
 *             ground it would be a smudge, so light palettes turn it off)
 *   anchorGlow colour of the sprite drawn where the web lands, once it has
 *             arrived (see drawWeb in canvas.js). This used to be a single
 *             hardcoded blue-white regardless of palette, which read fine on
 *             midnight and clashed on everything with a warm sky — a cool
 *             blob sitting on a red or orange ground reads as an error, not
 *             as the web having stuck to something. Warm/pale on the warm
 *             skies, ink-coloured on the print palettes (a stamped hit
 *             reads truer than a glow on flat cream), unchanged blue on
 *             midnight since that is the one sky it was ever tuned against.
 */

export const PALETTES = {
  /**
   * The original. Kept because it is what shipped, and because it is the
   * control the others have to beat — it is genuinely the weakest of the six
   * for figure separation, and having it one keypress away makes that
   * arguable rather than asserted.
   */
  midnight: {
    label: 'Midnight (original)',
    city: {
      skyTop: '#0b1020',
      skyBottom: '#2a1f3d',
      buildingColor: '#080a14',
      windowColor: '#ffd9a0',
    },
    render: {
      bodyColor: '#05060c',
      rimColor: '#8fc8ff',
      webColor: '#e8f2ff',
      accentColor: '#ff4d5e',
      targetColor: '#ff4d5e',
      chromaAmount: 0,
      speedLineColor: 'rgba(255,255,255,0.5)',
      krackleCore: '#ffffff',
      krackleRim: '#5fb0ff',
    },
    halftone: { cell: 5, radius: 1.2, color: '#ffffff', alpha: 0.05, op: 'overlay' },
    grain: 0,
    halo: 'rgba(2,3,10,0.62)',
    anchorGlow: 'rgba(140,200,255,0.5)',
  },

  /**
   * The default. Best figure separation of the six, and the print texture is
   * what stops the flat shapes reading as computer-generated.
   */
  noir: {
    label: 'Noir print',
    city: {
      skyTop: '#d4502f',
      skyBottom: '#33101c',
      buildingColor: '#0a0508',
      windowColor: '#ffc247',
    },
    render: {
      bodyColor: '#07040a',
      rimColor: '#ff9640',
      webColor: '#ffe2b0',
      accentColor: '#ffd166',
      targetColor: '#ffe2b0',
      chromaAmount: 1.8,
      speedLineColor: 'rgba(255,225,180,0.42)',
      krackleCore: '#fff2d0',
      krackleRim: '#ff9640',
    },
    halftone: { cell: 6, radius: 2.1, color: '#1a0a10', alpha: 0.17, op: 'multiply' },
    grain: 0.1,
    // Alpha dropped from 0.5: at that strength the halo read as a muddy
    // smudge against the red sky instead of raised contrast, because a dark
    // patch on an already-saturated ground reads as an object, not as
    // negative space. Thinned until it stopped registering as a shape and
    // only did its job — the figure separating from the sky behind it.
    halo: 'rgba(20,4,8,0.22)',
    anchorGlow: 'rgba(255,226,176,0.5)',
  },

  /** Same recipe, cool key. The evidence that this is a system. */
  magicHour: {
    label: 'Magic hour',
    city: {
      skyTop: '#1b3a8f',
      skyBottom: '#f2795c',
      buildingColor: '#0a0812',
      windowColor: '#ffd98a',
    },
    render: {
      bodyColor: '#08060f',
      rimColor: '#ffca6b',
      webColor: '#fff0cf',
      accentColor: '#ff7a5c',
      targetColor: '#fff0cf',
      chromaAmount: 1.8,
      speedLineColor: 'rgba(255,240,207,0.4)',
      krackleCore: '#fff6e0',
      krackleRim: '#ffca6b',
    },
    halftone: { cell: 6, radius: 2.1, color: '#0f0a1a', alpha: 0.17, op: 'multiply' },
    grain: 0.1,
    // Same fix as noir, same reason: the sky here is just as saturated at the
    // horizon, so the halo needs the same thinning to stop reading as a
    // blob sitting on top of it.
    halo: 'rgba(6,4,16,0.2)',
    anchorGlow: 'rgba(255,240,207,0.5)',
  },

  /**
   * Light ground. The halo is off and the halftone is the heaviest of the set,
   * because on cream the dot screen is doing the job the dark sky does
   * elsewhere — giving the flat shapes something to sit on.
   */
  newsprint: {
    label: 'Newsprint',
    city: {
      skyTop: '#f4e7c8',
      skyBottom: '#e6cf9c',
      buildingColor: '#22406b',
      windowColor: '#d8452f',
    },
    render: {
      bodyColor: '#151019',
      rimColor: '#d8452f',
      webColor: '#2b2028',
      accentColor: '#d8452f',
      targetColor: '#d8452f',
      chromaAmount: 2.4,
      speedLineColor: 'rgba(34,25,32,0.35)',
      krackleCore: '#d8452f',
      krackleRim: '#22406b',
    },
    halftone: { cell: 7, radius: 2.5, color: '#8a5a3c', alpha: 0.3, op: 'multiply' },
    grain: 0.11,
    halo: null,
    anchorGlow: 'rgba(43,32,40,0.5)',
  },

  /** Two inks on off-white. Softest of the set; kept for the comparison. */
  riso: {
    label: 'Risograph',
    city: {
      skyTop: '#f0ebe2',
      skyBottom: '#f7c3d0',
      buildingColor: '#2b3a8c',
      windowColor: '#ff4d8d',
    },
    render: {
      bodyColor: '#1b2470',
      rimColor: '#ff4d8d',
      webColor: '#2b3a8c',
      accentColor: '#ff4d8d',
      targetColor: '#ff4d8d',
      chromaAmount: 3.2,
      speedLineColor: 'rgba(43,58,140,0.32)',
      krackleCore: '#ff4d8d',
      krackleRim: '#2b3a8c',
    },
    halftone: { cell: 6, radius: 2.0, color: '#2b3a8c', alpha: 0.22, op: 'multiply' },
    grain: 0.16,
    halo: null,
    anchorGlow: 'rgba(43,58,140,0.5)',
  },
};

/** Order for the cycle key, so pressing it walks a deliberate sequence. */
export const PALETTE_ORDER = ['noir', 'magicHour', 'newsprint', 'riso', 'midnight'];

export const DEFAULT_PALETTE = 'noir';
