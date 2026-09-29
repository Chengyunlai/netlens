/**
 * 共用的小工具：时间基准与终端对齐。
 *
 * 这里刻意不引第三方库 —— 整个实验只用 Node 内置模块，
 * 目的就是让"哪些是语言给的、哪些是网络协议本身"分得清。
 */

/**
 * 一次探测共用一条时间基准线：所有耗时都是相对它的偏移。
 *
 * 记录绝对时间戳而不是累计耗时，因为协议里任意两个时间点都可能需要求差
 * （比如"扣掉建连之后服务端花了多久"），存差值会让分析角度被数据结构锁死。
 */
export class Stopwatch {
  private readonly origin = performance.now();

  /** 当前时刻相对起点的毫秒偏移。 */
  at(): number {
    return performance.now() - this.origin;
  }

  /** 把 performance.now() 的绝对值换算成相对偏移。 */
  rel(absolute: number): number {
    return absolute - this.origin;
  }
}

export const formatMs = (value: number | null | undefined): string =>
  value == null ? '—' : `${value.toFixed(1)} ms`;

/**
 * 中文在终端占两列，按字符串长度对齐会错位，所以自己算显示宽度。
 * 覆盖全角标点与 CJK 区间即可，不需要完整的 Unicode 东亚宽度表。
 */
export const displayWidth = (text: string): number =>
  [...text].reduce(
    (width, char) =>
      width +
      (/[\u2018-\u2019\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uff60\uffe0-\uffe6]/.test(char)
        ? 2
        : 1),
    0,
  );

/** 按显示宽度右侧补空格。 */
export const padTo = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - displayWidth(text)));

/** 一级小标题：终端里用符号而不是颜色，避免依赖终端能力。 */
export const section = (index: number, title: string, note: string): string[] => [
  '',
  `[${index}] ${title}`,
  `     ${note}`,
];
