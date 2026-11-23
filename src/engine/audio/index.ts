/**
 * 音频系统公共入口（src/engine/audio）。
 *
 * 总线图：Master → Weapons / Footsteps / Ambience / UI
 * 用法：
 *   const audio = new AudioSystem();          // 不创建 AudioContext
 *   button.onclick = () => audio.ensure();    // 用户手势内初始化
 *   audio.setListener(eye, forward);          // 只接收数值
 *   const voice = audio.play('rifle', { position });
 *   voice.stop();
 */
export * from './types';
export * from './defs';
export * from './buses';
export * from './voices';
export * from './spatial';
export * from './synth';
export * from './sounds';
export { AudioSystem } from './system';
