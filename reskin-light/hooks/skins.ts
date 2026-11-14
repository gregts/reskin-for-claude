// GENERATED from Reskin's presets (skin/skin-tool/presets/*.css) by the maintainers' generator. Do not edit by hand.
// Each half is makeColors input: gray anchors and roles. A few dark halves differ slightly from the presets so Claude
// agrees to paint them (it refuses a theme with any text under 3:1).
export type Role = string | { seed: string; fillShade: number }
export type Half = { anchors: Record<string, string>; roles: Record<string, Role> }
export type Skin = { label: string; light: Half; dark: Half }
export const SKINS: Record<string, Skin> = {
  "absolutely": {
    "label": "Absolutely",
    "light": {
      "anchors": {
        "surface-0": "#f4f4f2",
        "surface-1": "#f9f9f7",
        "surface-2": "#ffffff",
        "surface-3": "#ffffff",
        "text-primary": "#2d2d2b",
        "text-secondary": "#585856",
        "text-muted": "#636361"
      },
      "roles": {
        "accent": "#ae6244",
        "danger": "#8e2626",
        "success": "#006300",
        "warning": "#734500"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#2d2d2b",
        "surface-1": "#2d2d2b",
        "surface-2": "#373735",
        "surface-3": "#424240",
        "text-primary": "#f9f9f7",
        "text-secondary": "#c6c6c4",
        "text-muted": "#b2b2b0"
      },
      "roles": {
        "accent": "#cf7f60",
        "danger": "#f09a9a",
        "success": "#66c566",
        "warning": "#e2a62d"
      }
    }
  },
  "ayu": {
    "label": "Ayu",
    "light": {
      "anchors": {
        "surface-0": "#f8f9fa",
        "surface-1": "#fcfcfc",
        "surface-2": "#ffffff",
        "surface-3": "#ffffff",
        "text-primary": "#585d62",
        "text-secondary": "#565f69",
        "text-muted": "#676869"
      },
      "roles": {
        "accent": "#aa6700",
        "danger": "#b63f3f",
        "success": "#417428",
        "warning": "#905a0e",
        "pro": "#a37acc"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#0d1017",
        "surface-1": "#10141c",
        "surface-2": "#141821",
        "surface-3": "#1b1f28",
        "text-primary": "#bfbdb6",
        "text-secondary": "#8f95a3",
        "text-muted": "#828b95"
      },
      "roles": {
        "accent": "#e6b450",
        "danger": "#dd6767",
        "success": "#70bf56",
        "warning": "#e6b450",
        "pro": "#d2a6ff"
      }
    }
  },
  "catppuccin": {
    "label": "Catppuccin",
    "light": {
      "anchors": {
        "surface-0": "#e6e9ef",
        "surface-1": "#eff1f5",
        "surface-2": "#f8f9fb",
        "surface-3": "#f8f9fb",
        "text-primary": "#4c4f69",
        "text-secondary": "#4f5267",
        "text-muted": "#595c6e"
      },
      "roles": {
        "accent": "#1e66f5",
        "danger": "#b90e32",
        "success": "#2a6a1d",
        "warning": "#815211",
        "pro": "#8839ef"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#181825",
        "surface-1": "#1e1e2e",
        "surface-2": "#313244",
        "surface-3": "#3a3c4f",
        "text-primary": "#cdd6f4",
        "text-secondary": "#b1b7cf",
        "text-muted": "#a5a9ba"
      },
      "roles": {
        "accent": "#89b4fa",
        "danger": "#f38ba8",
        "success": "#a6e3a1",
        "warning": "#f9e2af",
        "pro": "#cba6f7"
      }
    }
  },
  "classic": {
    "label": "Classic",
    "light": {
      "anchors": {
        "surface-0": "#f0eee6",
        "surface-1": "#faf9f5",
        "surface-2": "#ffffff",
        "surface-3": "#ffffff",
        "text-primary": "#141413",
        "text-secondary": "#3d3d3a",
        "text-muted": "#615f5b"
      },
      "roles": {
        "accent": "#4a7aa9",
        "danger": "#8e2626",
        "success": "#006300",
        "warning": "#734500"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#1f1e1d",
        "surface-1": "#262624",
        "surface-2": "#30302e",
        "surface-3": "#3c3c3a",
        "text-primary": "#faf9f5",
        "text-secondary": "#c2c0b6",
        "text-muted": "#a8a6a2"
      },
      "roles": {
        "accent": "#6a9bcc",
        "danger": "#ee8b8b",
        "success": "#50bd50",
        "warning": "#dd990f"
      }
    }
  },
  "dracula": {
    "label": "Dracula",
    "light": {
      "anchors": {
        "surface-0": "#ece9df",
        "surface-1": "#fffbeb",
        "surface-2": "#fffdf6",
        "surface-3": "#fffdf6",
        "text-primary": "#1f1f1f",
        "text-secondary": "#555450",
        "text-muted": "#635e45"
      },
      "roles": {
        "accent": "#644ac9",
        "danger": "#ac3223",
        "success": "#136c0a",
        "warning": "#705d12",
        "pro": "#bd93f9"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#21222c",
        "surface-1": "#282a36",
        "surface-2": "#343746",
        "surface-3": "#3e414f",
        "text-primary": "#f8f8f2",
        "text-secondary": "#c4c5c3",
        "text-muted": "#a7b0cc"
      },
      "roles": {
        "accent": "#bd93f9",
        "danger": "#ff9292",
        "success": "#50fa7b",
        "warning": "#f1fa8c",
        "pro": "#bd93f9"
      }
    }
  },
  "github": {
    "label": "GitHub",
    "light": {
      "anchors": {
        "surface-0": "#f6f8fa",
        "surface-1": "#ffffff",
        "surface-2": "#ffffff",
        "surface-3": "#ffffff",
        "text-primary": "#1f2328",
        "text-secondary": "#545d67",
        "text-muted": "#5f6771"
      },
      "roles": {
        "accent": "#0969da",
        "danger": "#c4222c",
        "success": "#187533",
        "warning": "#8b5d00",
        "pro": "#8250df"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#010409",
        "surface-1": "#0d1117",
        "surface-2": "#151b23",
        "surface-3": "#222830",
        "text-primary": "#f0f6fc",
        "text-secondary": "#959ca5",
        "text-muted": "#8a8f97"
      },
      "roles": {
        "accent": "#4493f8",
        "danger": "#f85751",
        "success": "#3fb950",
        "warning": "#d29922",
        "pro": "#ab7df8"
      }
    }
  },
  "gruvbox": {
    "label": "Gruvbox",
    "light": {
      "anchors": {
        "surface-0": "#f2e5bc",
        "surface-1": "#fbf1c7",
        "surface-2": "#f9f5d7",
        "surface-3": "#f9f5d7",
        "text-primary": "#3c3836",
        "text-secondary": "#504945",
        "text-muted": "#655a51"
      },
      "roles": {
        "accent": "#076678",
        "danger": "#9d0006",
        "success": "#625e0c",
        "warning": "#7f530e",
        "pro": "#8f3f71"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#1d2021",
        "surface-1": "#282828",
        "surface-2": "#3c3836",
        "surface-3": "#423d3a",
        "text-primary": "#ebdbb2",
        "text-secondary": "#d5c4a1",
        "text-muted": "#b7ada3"
      },
      "roles": {
        "accent": "#83a598",
        "danger": "#fd9285",
        "success": "#b8bb26",
        "warning": "#fabd2f",
        "pro": "#d3869b"
      }
    }
  },
  "kanagawa": {
    "label": "Kanagawa",
    "light": {
      "anchors": {
        "surface-0": "#d5cea3",
        "surface-1": "#f2ecbc",
        "surface-2": "#f9f6e1",
        "surface-3": "#f9f6e1",
        "text-primary": "#4a4a58",
        "text-secondary": "#4d4c43",
        "text-muted": "#56554f"
      },
      "roles": {
        "accent": "#4d699b",
        "danger": "#a91a1a",
        "success": "#4a5b34",
        "warning": "#7b4a00",
        "pro": "#957fb8"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#16161d",
        "surface-1": "#1f1f28",
        "surface-2": "#2a2a37",
        "surface-3": "#35343f",
        "text-primary": "#dcd7ba",
        "text-secondary": "#c8c093",
        "text-muted": "#9f9e99"
      },
      "roles": {
        "accent": "#7e9cd8",
        "danger": "#f17c7c",
        "success": "#98bb6c",
        "warning": "#ff9e3b",
        "pro": "#957fb8"
      }
    }
  },
  "linea": {
    "label": "Linea",
    "light": {
      "anchors": {
        "surface-0": "#f2f4f8",
        "surface-1": "#fcfcfd",
        "surface-2": "#ffffff",
        "surface-3": "#ffffff",
        "text-primary": "#1b1b1b",
        "text-secondary": "#4a5263",
        "text-muted": "#5f6571"
      },
      "roles": {
        "accent": "#5e6ad2",
        "danger": "#ae3b3c",
        "success": "#387137",
        "warning": "#734500"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#080a0f",
        "surface-1": "#0f0f11",
        "surface-2": "#17181d",
        "surface-3": "#232429",
        "text-primary": "#e3e4e6",
        "text-secondary": "#aeafb1",
        "text-muted": "#858c98"
      },
      "roles": {
        "accent": "#606acc",
        "danger": "#ff7e78",
        "success": "#69c967",
        "warning": "#db9300"
      }
    }
  },
  "night-owl": {
    "label": "Night Owl",
    "light": {
      "anchors": {
        "surface-0": "#f0f0f0",
        "surface-1": "#fbfbfb",
        "surface-2": "#ffffff",
        "surface-3": "#ffffff",
        "text-primary": "#403f53",
        "text-secondary": "#565562",
        "text-muted": "#566369"
      },
      "roles": {
        "accent": "#03857c",
        "danger": "#aa3936",
        "success": "#256a64",
        "warning": "#775c01",
        "pro": "#994cc3"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#01121f",
        "surface-1": "#011627",
        "surface-2": "#0e293f",
        "surface-3": "#1a3449",
        "text-primary": "#d6deeb",
        "text-secondary": "#90a9bf",
        "text-muted": "#8c9ca9"
      },
      "roles": {
        "accent": "#9069d6",
        "danger": "#f27270",
        "success": "#9ccc65",
        "warning": "#b39554",
        "pro": "#c792ea"
      }
    }
  },
  "nord": {
    "label": "Nord",
    "light": {
      "anchors": {
        "surface-0": "#e5e9f0",
        "surface-1": "#eceff4",
        "surface-2": "#ffffff",
        "surface-3": "#ffffff",
        "text-primary": "#2e3440",
        "text-secondary": "#495366",
        "text-muted": "#525d73"
      },
      "roles": {
        "accent": "#5679a3",
        "danger": "#8d474e",
        "success": "#546248",
        "warning": "#7c5143",
        "pro": "#b48ead"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#252a33",
        "surface-1": "#2e3440",
        "surface-2": "#383f4e",
        "surface-3": "#383f4e",
        "text-primary": "#d8dee9",
        "text-secondary": "#c6cbd2",
        "text-muted": "#b6bcc8"
      },
      "roles": {
        "accent": "#88c0d0",
        "danger": "#dfb0b5",
        "success": "#a9c293",
        "warning": "#ebcb8b",
        "pro": "#b48ead"
      }
    }
  },
  "one": {
    "label": "One",
    "light": {
      "anchors": {
        "surface-0": "#eaeaeb",
        "surface-1": "#fafafa",
        "surface-2": "#ffffff",
        "surface-3": "#ffffff",
        "text-primary": "#383a42",
        "text-secondary": "#50535b",
        "text-muted": "#5c5d60"
      },
      "roles": {
        "accent": "#386fe8",
        "danger": "#a03c33",
        "success": "#346833",
        "warning": "#7d5601",
        "pro": "#a626a4"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#21252b",
        "surface-1": "#282c34",
        "surface-2": "#2c313a",
        "surface-3": "#343942",
        "text-primary": "#abb2bf",
        "text-secondary": "#adb2b9",
        "text-muted": "#a0a5ac"
      },
      "roles": {
        "accent": "#61afef",
        "danger": "#e78890",
        "success": "#98c379",
        "warning": {
          "seed": "#e5c07b",
          "fillShade": 400
        },
        "pro": "#c678dd"
      }
    }
  },
  "rose-pine": {
    "label": "Rosé Pine",
    "light": {
      "anchors": {
        "surface-0": "#f2e9e1",
        "surface-1": "#faf4ed",
        "surface-2": "#fffaf3",
        "surface-3": "#fffaf3",
        "text-primary": "#464261",
        "text-secondary": "#544f74",
        "text-muted": "#5d5b72"
      },
      "roles": {
        "accent": "#286983",
        "danger": "#884b5c",
        "success": "#3b656d",
        "warning": "#7e551c",
        "pro": "#907aa9"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#16141f",
        "surface-1": "#191724",
        "surface-2": "#1f1d2e",
        "surface-3": "#2b293a",
        "text-primary": "#e0def4",
        "text-secondary": "#9f9cb6",
        "text-muted": "#9491a5"
      },
      "roles": {
        "accent": "#9ccfd8",
        "danger": "#eb6f92",
        "success": "#6b9bae",
        "warning": "#f6c177",
        "pro": "#c4a7e7"
      }
    }
  },
  "solarized": {
    "label": "Solarized",
    "light": {
      "anchors": {
        "surface-0": "#eee8d5",
        "surface-1": "#fdf6e3",
        "surface-2": "#fefbf2",
        "surface-3": "#fefbf2",
        "text-primary": "#073642",
        "text-secondary": "#44555c",
        "text-muted": "#4e5f66"
      },
      "roles": {
        "accent": "#097cc1",
        "danger": "#b22826",
        "success": "#566300",
        "warning": "#755900",
        "pro": "#6c71c4"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#00222b",
        "surface-1": "#002b36",
        "surface-2": "#073642",
        "surface-3": "#0f3c48",
        "text-primary": "#a4b0b0",
        "text-secondary": "#a1aeb0",
        "text-muted": "#94a2a7"
      },
      "roles": {
        "accent": "#3093da",
        "danger": "#ea8482",
        "success": "#99a929",
        "warning": {
          "seed": "#c19c29",
          "fillShade": 400
        },
        "pro": "#6c71c4"
      }
    }
  },
  "tokyo-night": {
    "label": "Tokyo Night",
    "light": {
      "anchors": {
        "surface-0": "#d0d5e3",
        "surface-1": "#e1e2e7",
        "surface-2": "#f2f2f4",
        "surface-3": "#f2f2f4",
        "text-primary": "#274285",
        "text-secondary": "#40465f",
        "text-muted": "#4a4f66"
      },
      "roles": {
        "accent": "#1569d3",
        "danger": "#9b1a40",
        "success": "#43582b",
        "warning": "#654d2d",
        "pro": "#9854f1"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#16161e",
        "surface-1": "#1a1b26",
        "surface-2": "#292e42",
        "surface-3": "#2d3247",
        "text-primary": "#c0caf5",
        "text-secondary": "#a9b1d6",
        "text-muted": "#9a9fbc"
      },
      "roles": {
        "accent": "#7aa2f7",
        "danger": "#f77990",
        "success": "#9ece6a",
        "warning": "#e0af68",
        "pro": "#bb9af7"
      }
    }
  },
  "vs": {
    "label": "VS",
    "light": {
      "anchors": {
        "surface-0": "#f3f3f3",
        "surface-1": "#ffffff",
        "surface-2": "#ffffff",
        "surface-3": "#ffffff",
        "text-primary": "#000000",
        "text-secondary": "#5a5a5a",
        "text-muted": "#646464"
      },
      "roles": {
        "accent": "#006ab1",
        "danger": "#a1260d",
        "success": "#346e43",
        "warning": "#835d02",
        "pro": "#af00db"
      }
    },
    "dark": {
      "anchors": {
        "surface-0": "#1e1e1e",
        "surface-1": "#1e1e1e",
        "surface-2": "#252526",
        "surface-3": "#303030",
        "text-primary": "#d4d4d4",
        "text-secondary": "#a6a6a6",
        "text-muted": "#999999"
      },
      "roles": {
        "accent": "#3794ff",
        "danger": "#f48771",
        "success": "#7fa54e",
        "warning": "#cca700",
        "pro": "#c586c0"
      }
    }
  }
}
// Short and old names, copied from the full flavour's SKIN_ALIASES (skin-tool/skin-lib.mjs) so /skin dra means
// the same in both flavours.
export const ALIASES: Record<string, string> = {
  "abs": "absolutely",
  "cat": "catppuccin",
  "cla": "classic",
  "dra": "dracula",
  "git": "github",
  "gru": "gruvbox",
  "kan": "kanagawa",
  "lin": "linea",
  "nig": "night-owl",
  "owl": "night-owl",
  "nor": "nord",
  "ros": "rose-pine",
  "sol": "solarized",
  "tok": "tokyo-night",
  "catppuccin-auto": "catppuccin",
  "catppuccin-latte": "catppuccin",
  "catppuccin-mocha": "catppuccin",
  "catppuccin-frappe": "catppuccin",
  "catppuccin-macchiato": "catppuccin",
  "classic-auto": "classic",
  "classic-dark": "classic",
  "classic-light": "classic",
  "claude-cream": "classic",
  "claude-warm": "classic",
  "warm-dark": "classic",
  "github-auto": "github",
  "github-dark": "github",
  "github-light": "github",
  "gruvbox-auto": "gruvbox",
  "gruvbox-dark": "gruvbox",
  "gruvbox-light": "gruvbox",
  "one-auto": "one",
  "one-dark": "one",
  "one-light": "one",
  "rose-pine-auto": "rose-pine",
  "rose-pine-dawn": "rose-pine",
  "rose-pine-moon": "rose-pine",
  "rosepine": "rose-pine",
  "solarized-dark": "solarized",
  "solarized-light": "solarized",
  "tokyo-night-auto": "tokyo-night",
  "tokyo-night-day": "tokyo-night",
  "tokyo-night-storm": "tokyo-night",
  "tokyo-night-light": "tokyo-night",
  "tokyonight": "tokyo-night",
  "nightowl": "night-owl",
  "kanagawa-wave": "kanagawa",
  "kanagawa-lotus": "kanagawa",
  "ayu-light": "ayu",
  "ayu-dark": "ayu",
  "ayu-mirage": "ayu",
  "dracula-light": "dracula"
}
