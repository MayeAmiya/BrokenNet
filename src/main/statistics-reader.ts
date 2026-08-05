import path from 'path'
import fs from 'fs'
import { loadIniFile } from './ini-parser'

export interface StatisticsWindowConfig {
  returnButtonLocation: { x: number; y: number }
  returnButtonText: string
  clearButtonLocation: { x: number; y: number }
  clearButtonText: string
  clearButtonVisible: boolean
  speedrunButtonLocation: { x: number; y: number }
  speedrunButtonText: string
  speedrunButtonUrl: string
  columnWidths: number[]
  gameModeFilterSize: { width: number; height: number }
}

function parseLocation(value: string): { x: number; y: number } {
  const parts = value.split(',').map(s => parseInt(s.trim(), 10))
  return { x: parts[0] || 0, y: parts[1] || 0 }
}

function parseSize(value: string): { width: number; height: number } {
  const parts = value.split(',').map(s => parseInt(s.trim(), 10))
  return { width: parts[0] || 0, height: parts[1] || 0 }
}

/**
 * Load statistics window config from StatisticsWindow.ini.
 */
export function loadStatisticsWindow(gamePath: string): StatisticsWindowConfig | null {
  const iniPath = path.join(gamePath, 'Resources', 'StatisticsWindow.ini')
  if (!fs.existsSync(iniPath)) return null

  const ini = loadIniFile(iniPath)

  const returnSec = ini.getSection('btnReturnToMenu')
  const clearSec = ini.getSection('btnClearStatistics')
  const speedrunSec = ini.getSection('btnSpeedrun')
  const statsSec = ini.getSection('lbGameStatistics')
  const filterSec = ini.getSection('cmbGameModeFilter')

  const columnWidths: number[] = []
  if (statsSec) {
    for (let i = 0; i <= 7; i++) {
      columnWidths.push(statsSec.getInt(`ColumnWidth${i}`, 80))
    }
  }

  return {
    returnButtonLocation: parseLocation(returnSec?.getString('Location') ?? '530,486'),
    returnButtonText: returnSec?.getString('Text') ?? '返回主菜单',
    clearButtonLocation: parseLocation(clearSec?.getString('Location') ?? '269,486'),
    clearButtonText: clearSec?.getString('Text') ?? '清除统计数据',
    clearButtonVisible: clearSec?.getBoolean('Visible', true) ?? true,
    speedrunButtonLocation: parseLocation(speedrunSec?.getString('Location') ?? '10,486'),
    speedrunButtonText: speedrunSec?.getString('Text') ?? '竞速通关排行榜',
    speedrunButtonUrl: speedrunSec?.getString('URL') ?? '',
    columnWidths,
    gameModeFilterSize: parseSize(filterSec?.getString('Size') ?? '140,21')
  }
}
