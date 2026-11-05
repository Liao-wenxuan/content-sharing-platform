/**
 * 视频工具的纯函数部分
 *
 * captureVideoPoster 依赖真实视频解码（jsdom 没有），
 * 不在单测里测 —— 它的兜底是「返回 null 不阻塞发布」，
 * 真验证要靠浏览器端的手工/e2e。
 * 这里测的是**同步校验**：类型白名单 + 大小上限。
 * 别看逻辑简单 —— 它是「把 4G 电影选进来卡死页面」的第一道闸。
 */

import { describe, it, expect } from 'vitest'
import { validateVideoFile, VIDEO_ALLOWED_TYPES } from '@/utils/video'

describe('validateVideoFile', () => {
  const MB = 1024 * 1024

  it('MP4 / WebM 都放行', () => {
    for (const type of VIDEO_ALLOWED_TYPES) {
      const file = new File([new Uint8Array(10)], `v.${type === 'video/mp4' ? 'mp4' : 'webm'}`, {
        type
      })
      expect(validateVideoFile(file, 50 * MB).ok).toBe(true)
    }
  })

  it('其它类型拒绝（哪怕扩展名是 .mp4）', () => {
    // Content-Type 由浏览器/系统决定，扩展名说谎是常态
    const file = new File([new Uint8Array(10)], 'movie.mp4', { type: 'video/x-matroska' })
    const v = validateVideoFile(file, 50 * MB)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('MP4')
  })

  it('超过大小上限拒绝', () => {
    const file = new File([new Uint8Array(60)], 'big.mp4', { type: 'video/mp4' })
    const v = validateVideoFile(file, 50)
    expect(v.ok).toBe(false)
  })

  it('空文件拒绝', () => {
    const file = new File([], 'empty.mp4', { type: 'video/mp4' })
    const v = validateVideoFile(file, 50 * MB)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('空')
  })
})
