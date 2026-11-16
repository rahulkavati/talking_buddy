// Colour themes: sky, meadow, trees, light and buddy colour. Each one is a complete mood.
// `glow` adds a little self-light to the buddy so it stays readable in dark scenes.
export const THEMES = {
  golden: {
    body: 0xd9443a, mitt: 0xcf3d34, eye: 0x0b1620, pupil: 0x69f0d6, rim: 0xffb873, sheen: 0xff9a8a, glow: 0,
    sky: { top: 0xbda8b8, mid: 0xefbaa2, low: 0xf8cf8a, glow: 0xffc870, gain: 1, glowK: .25, disc: 0xfff2b3, cloud: [0xffe4d6, 0xf0c2bc, 0xd2a8b4, 0xffd8a8] },
    grass: { root: 0x2f4416, body: 0x6f8c36, light: 0x9fb040, gold: 0xffe9a0, warm: 0xffd98c, amb: 0xcfc596 },
    ground: [[.075, .095, .03], [.2, .235, .07], [.46, .40, .14], [.43, .4, .24]],
    leaf: [0x9aa45a, 0x8a964c, 0x76843f, 0x66752f], haze: 0xd9b89a, hills: [0x8a8f66, 0x9a8c70],
    sun: 0xffc27a, sunI: 3.2, key: 0xffe6cf, keyI: 2.1, fill: 0xffd7bd, hemi: [0xf2cfc0, 0x7d8a3c, 1.25], motes: 0xfff0be, exposure: 1,
  },
  blossom: {
    body: 0x6fc3e6, mitt: 0x5db4da, eye: 0x1b1030, pupil: 0xff7fb6, rim: 0xffd1e0, sheen: 0xcdf1ff, glow: 0,
    sky: { top: 0xc9b6e6, mid: 0xffc4d6, low: 0xffe7c2, glow: 0xffd2dc, gain: 1.04, glowK: .3, disc: 0xfff6e8, cloud: [0xfff0f3, 0xffd3e0, 0xe6b8dc, 0xffe2e8] },
    grass: { root: 0x3f6a4a, body: 0x8dc08a, light: 0xc9e6a2, gold: 0xfff0f4, warm: 0xffe6ea, amb: 0xe9dfe8 },
    ground: [[.06, .13, .08], [.2, .34, .17], [.55, .56, .34], [.62, .52, .5]],
    leaf: [0xf7b5cc, 0xf09ab9, 0xe685a8, 0xd9739a], haze: 0xf0cfd6, hills: [0xb7a6c8, 0xc4aac4],
    sun: 0xffd3d9, sunI: 3, key: 0xfff1f4, keyI: 2.1, fill: 0xffd9e6, hemi: [0xf6dbe6, 0x8fb98a, 1.35], motes: 0xffd0e0, exposure: 1.02,
  },
  autumn: {
    body: 0x2fb3a8, mitt: 0x27a196, eye: 0x1a0d08, pupil: 0xffd24a, rim: 0xffa650, sheen: 0x9ff0e4, glow: .05,
    sky: { top: 0x9d6f8a, mid: 0xff9a6a, low: 0xffc15e, glow: 0xff9d4a, gain: 1.05, glowK: .32, disc: 0xffe9a8, cloud: [0xffd0a0, 0xf0a08a, 0xb87088, 0xffb878] },
    grass: { root: 0x4a3a14, body: 0xb08a2a, light: 0xe0b845, gold: 0xfff0a0, warm: 0xffc878, amb: 0xe0b890 },
    ground: [[.1, .07, .02], [.34, .22, .05], [.62, .4, .1], [.55, .38, .2]],
    leaf: [0xe0742a, 0xc9582a, 0xe89a35, 0xa8432a], haze: 0xe8a97a, hills: [0x9a6a58, 0xb07a5a],
    sun: 0xff9d52, sunI: 3.4, key: 0xffd2a8, keyI: 1.9, fill: 0xffb98a, hemi: [0xf0b894, 0x8a6a30, 1.2], motes: 0xffb060, exposure: 1.0,
  },
  moonlit: {
    body: 0xff9a52, mitt: 0xf58a44, eye: 0x06101c, pupil: 0xbff6ff, rim: 0x9fc4ff, sheen: 0xffd2a8, glow: .34,
    sky: { top: 0x1c2250, mid: 0x4a4a92, low: 0x8f84c0, glow: 0x9aa6ff, gain: .95, glowK: .22, disc: 0xf3f6ff, cloud: [0x8c92d8, 0x5f68b0, 0x3d4486, 0xaab0f0] },
    grass: { root: 0x0f2a3a, body: 0x2a6d78, light: 0x5fb3b8, gold: 0xa8f0ff, warm: 0x9ec8ff, amb: 0x6f86c0 },
    ground: [[.01, .04, .07], [.04, .13, .18], [.1, .26, .3], [.12, .16, .3]],
    leaf: [0x3c5f93, 0x2f4f84, 0x264070, 0x1d3360], haze: 0x5a5fa0, hills: [0x2c3470, 0x3a3f84],
    sun: 0x9fb6ff, sunI: 2.2, key: 0xd8d0ff, keyI: 1.5, fill: 0xffc8a0, hemi: [0x7f8ed0, 0x1f4050, 1.0], motes: 0xd8ff9a, exposure: 1.1,
  },
  neon: {
    body: 0xeef0fa, mitt: 0xdde0f2, eye: 0x120a24, pupil: 0xff3fa8, rim: 0xff5fc0, sheen: 0xffffff, glow: .1,
    sky: { top: 0x2a1650, mid: 0xc43c9a, low: 0xff8a5c, glow: 0xff58b0, gain: 1.0, glowK: .34, disc: 0xffe2f4, cloud: [0xff9ad8, 0xc45ab8, 0x6a3a9a, 0xffb0a0] },
    grass: { root: 0x1a1240, body: 0x3a2a8a, light: 0x2fc8c8, gold: 0xff8ae0, warm: 0xff7ac8, amb: 0x9a6ad0 },
    ground: [[.02, .01, .07], [.08, .04, .24], [.12, .3, .4], [.4, .12, .4]],
    leaf: [0x7a3ab8, 0x5f2f9e, 0x9c4ac0, 0x3f2480], haze: 0xb85aa8, hills: [0x4a2a80, 0x6a3a96],
    sun: 0xff6fc0, sunI: 2.8, key: 0xc8b8ff, keyI: 1.5, fill: 0xff9ad8, hemi: [0xc08ae8, 0x2a1a60, 1.05], motes: 0x7fffe8, exposure: 1.05,
  },
};
