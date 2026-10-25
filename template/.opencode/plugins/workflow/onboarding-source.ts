export const SUPERPOWERS_REVISION = '2ce8aa15d05bd57213e6f746f953aafb7ded7a8b'
export const SUPERPOWERS_SPEC = `superpowers@git+https://github.com/obra/superpowers.git#${SUPERPOWERS_REVISION}`
export const SUPERPOWERS_SOURCE = {
  version: '7.0.1',
  archive: `https://codeload.github.com/obra/superpowers/tar.gz/${SUPERPOWERS_REVISION}`,
  archiveSha256: 'da34247c51339cdd6175b3590261f16e25b08d46669afd5b6fc3f842ab303e20',
  treeSha256: 'eef963df86dd36759676ffc7cac7f31144078f5ecfed77a08577ce39f10b587e',
  files: {
    'index.js': 'f0132fd5339befeb99ba903b1619fd9530969e5b4a1ea8cecf0b0a7f0213a099',
    '.opencode/plugins/superpowers.js': 'c979fe5a9fd6fddc9bc9730b34b25989f9d53939eed7d594c4564f6e47495f26',
    'package.json': 'b4ca961ce1aead5d08e40507b2fca8c04c61dea054866bac92259308d24527e3',
  },
  skills: {
    brainstorming: '8e43c8181a17642ac8c8b6e1c3fa29294ef5d3fa64f67eaa917ff709298a0b96',
    'writing-plans': '1fa01b954171b1d2b8bc0208dfbc6a01edf8a2ca715d18f76f043952e37e744f',
    'using-superpowers': '525604b2a0b2523074c447e5e658bf123b4092221b326a44c250092b2d09337b',
  },
} as const
