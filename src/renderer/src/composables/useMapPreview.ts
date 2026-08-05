import { ref } from 'vue'

interface MapPreviewData {
  previewPath: string | null
  previewDataUrl: string | null
  previewAvailable: boolean
  mapWidth: number
  mapHeight: number
  startingLocations: Array<{ x: number; y: number; waypoint: number }>
  extraTextures: Array<{ textureName: string; x: number; y: number; level: number; toggleable: boolean }>
  briefing: string
  isCoop: boolean
}

export function useMapPreview() {
  const previewData = ref<MapPreviewData | null>(null)
  const loading = ref(false)

  async function loadPreview(gamePath: string, mapFilePath: string): Promise<MapPreviewData | null> {
    if (!gamePath || !mapFilePath) { console.log('[useMapPreview] missing params, clearing'); clearPreview(); return null }
    console.log('[useMapPreview] loading:', { gamePath, mapFilePath })
    loading.value = true
    try {
      const data = await (window as any).api.mapPreview.load(gamePath, mapFilePath)
      console.log('[useMapPreview] result:', JSON.stringify({ previewAvailable: data?.previewAvailable, previewPath: data?.previewPath, briefing: data?.briefing?.substring(0, 100), startingLocations: data?.startingLocations?.length }))
      previewData.value = data
      return data
    } catch (e) {
      console.warn('[useMapPreview] load failed:', e)
      previewData.value = null
      return null
    } finally {
      loading.value = false
    }
  }

  function clearPreview(): void {
    previewData.value = null
  }

  return {
    previewData,
    loading,
    loadPreview,
    clearPreview
  }
}
