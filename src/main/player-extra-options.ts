/**
 * PlayerExtraOptionsPanel - manages extra player options for game lobbies.
 * Supports: Force Random Sides/Colors/Starts, Force No Teams, Auto Allying.
 */

export interface PlayerExtraOptions {
  forceRandomSides: boolean
  forceRandomColors: boolean
  forceRandomStarts: boolean
  forceNoTeams: boolean
  autoAlly: boolean
  teamStartMappings: Record<number, number> // startLocation -> team
}

export const DEFAULT_PLAYER_EXTRA_OPTIONS: PlayerExtraOptions = {
  forceRandomSides: false,
  forceRandomColors: false,
  forceRandomStarts: false,
  forceNoTeams: false,
  autoAlly: false,
  teamStartMappings: {}
}

/**
 * Generate team start mapping presets based on map waypoints.
 */
export function generateTeamStartPresets(
  maxPlayers: number,
  numTeams: number
): Record<number, number>[] {
  const presets: Record<number, number>[] = []

  if (numTeams <= 1 || maxPlayers <= 1) return presets

  // Simple sequential mapping: players 0,1 -> team 0; 2,3 -> team 1; etc.
  const preset: Record<number, number> = {}
  for (let i = 0; i < maxPlayers; i++) {
    preset[i] = Math.floor(i / Math.ceil(maxPlayers / numTeams))
  }
  presets.push(preset)

  // Alternate mapping: 0,2 -> team 0; 1,3 -> team 1
  if (maxPlayers >= 4) {
    const altPreset: Record<number, number> = {}
    for (let i = 0; i < maxPlayers; i++) {
      altPreset[i] = i % numTeams
    }
    presets.push(altPreset)
  }

  return presets
}
