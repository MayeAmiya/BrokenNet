/**
 * 游戏选项 → spawn.ini [Settings] 值 + spawnmap MapCode 文件。
 *
 * 对齐 xna GameSessionCheckBox / GameSessionDropDown 的
 * ApplySpawnIniCode / ApplyMapCode 两个环节：
 * - 复选框：勾选（非反选）→ 写启用值；否则写禁用值；生效时应用其 CustomIniPath。
 * - 下拉：DataWriteMode=MapCode → 选中项即 INI 路径（应用为 Map Code）；
 *   String/Index/Boolean → 写 spawn.ini。
 * - ForcedSpawnIniOptions：GameOptions.ini [ForcedSpawnIniOptions] 始终写入。
 */

export interface GameOptionCheckBox {
  name: string
  checked: boolean
  spawnIniOption: string
  customIniPath?: string
  reversed: boolean
  enabledSpawnIniValue: string
  disabledSpawnIniValue: string
  /** 勾选（反选框为未勾选）时连带禁用的阵营索引（对齐 xna GameLobbyCheckBox.DisallowedSideIndices） */
  disallowedSideIndices?: number[]
}

export interface GameOptionDropDown {
  name: string
  items: string[]
  defaultIndex: number
  spawnIniOption: string
  dataWriteMode: string
}

export interface LaunchGameOptions {
  /** 写入 spawn.ini [Settings] 的键值对 */
  spawnIniSettings: Record<string, string>
  /** 需要作为 Map Code 应用的游戏选项 INI 文件（相对游戏根目录） */
  customIniPaths: string[]
}

export function computeLaunchGameOptions(
  checkboxes: GameOptionCheckBox[],
  dropdowns: GameOptionDropDown[],
  checkboxValues: Record<string, boolean>,
  dropdownValues: Record<string, number>,
  forcedSpawnIniOptions: Record<string, string>
): LaunchGameOptions {
  const spawnIniSettings: Record<string, string> = {}
  const customIniPaths: string[] = []

  // 复选框：Checked != reversed → 启用值；否则禁用值（对齐 xna）
  for (const cb of checkboxes) {
    const enabled = (checkboxValues[cb.name] ?? cb.checked) !== cb.reversed
    if (cb.spawnIniOption) {
      spawnIniSettings[cb.spawnIniOption] = enabled ? cb.enabledSpawnIniValue : cb.disabledSpawnIniValue
    }
    if (cb.customIniPath && enabled) {
      customIniPaths.push(cb.customIniPath)
    }
  }

  // 下拉：MapCode 模式选中项即 INI 路径；其余模式写 spawn.ini
  for (const dd of dropdowns) {
    const idx = dropdownValues[dd.name] ?? dd.defaultIndex ?? 0
    if (dd.dataWriteMode === 'MapCode') {
      const iniPath = dd.items[idx]
      if (iniPath) customIniPaths.push(iniPath)
    } else if (dd.spawnIniOption) {
      if (dd.dataWriteMode === 'Boolean') {
        spawnIniSettings[dd.spawnIniOption] = String(idx > 0)
      } else if (dd.dataWriteMode === 'Index') {
        spawnIniSettings[dd.spawnIniOption] = String(idx)
      } else {
        spawnIniSettings[dd.spawnIniOption] = dd.items[idx] ?? ''
      }
    }
  }

  // 强制选项：始终写入
  for (const [k, v] of Object.entries(forcedSpawnIniOptions)) {
    spawnIniSettings[k] = v
  }

  return { spawnIniSettings, customIniPaths }
}
