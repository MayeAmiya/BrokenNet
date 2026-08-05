/**
 * C# System.Random（.NET Framework 4.x / Mono 经典算法）的精确 TypeScript 移植。
 *
 * 为什么需要它：参考客户端（xna-cncnet-client，DTA/MO 等官方客户端）在 spawn 阶段用
 * `new Random(RandomSeed)` 做"同种子各自随机"——每个客户端独立把 Random 阵营/颜色/起点
 * 解析成具体值，一致性完全靠共享种子 + 确定性 C# RNG（GameLobbyBase.Randomize +
 * PlayerHouseInfo.RandomizeSide/Color/Start）。JS 的 Math.random() 无种子且算法不同，
 * 加入外部房间时解析出的具体值会和官方客户端不一致 → spawn.ini 不同 → 开局 desync。
 *
 * 关键点：
 * 1. C# 用的是 **int 32 位回绕算术**（构造函数里 SeedArray[55] 可能为负，减负值会超过
 *    int.MaxValue 溢出回绕），所以必须用 Int32Array 存储并让赋值回绕，JS 裸 double 不会回绕；
 * 2. 其余运算都是 IEEE754 double，JS 与 C# 逐位一致，`Next(min,max)=floor(Sample()*range)+min`。
 *
 * 已用本机 .NET Framework 4.8 的 `new Random(seed)` 实测输出逐位校验（多组种子 + 长序列）。
 *
 * 注意：.NET Core 6+ 的 System.Random 换成 Xoshiro256StarStar，同种子输出与 net48 不同。
 * 若互通目标切到 .NET 8 客户端，只替换本文件算法（对外 API 不变）。
 */

const MBIG = 2147483647
const MSEED = 161803398

export class CSharpRandom {
  /** SeedArray[1..55] 参与计算（[0] 闲置，镜像 C# 的 1 基索引避免 +1 错位）；Int32Array 模拟 int 溢出回绕 */
  private readonly seedArray = new Int32Array(56)
  private inext = 0
  private inextp = 21

  constructor(seed: number) {
    // 镜像 C# Random(int) 构造函数（MSEED - |seed|，seed==int.MinValue 时按 int.MaxValue 处理）
    const subtraction = seed === -2147483648 ? 2147483647 : Math.abs(seed)
    let mj = MSEED - subtraction
    this.seedArray[55] = mj
    let mk = 1
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55
      this.seedArray[ii] = mk
      mk = mj - mk
      if (mk < 0) mk += MBIG
      mj = this.seedArray[ii]
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        this.seedArray[i] -= this.seedArray[1 + (i + 30) % 55]
        if (this.seedArray[i] < 0) this.seedArray[i] += MBIG
      }
    }
    this.inext = 0
    this.inextp = 21
  }

  /** 等价 C# Random.Sample()：推进状态并返回 [0, 1) 的 double */
  private sample(): number {
    let locINext = this.inext
    let locINextp = this.inextp
    if (++locINext >= 56) locINext = 1
    if (++locINextp >= 56) locINextp = 1
    let retVal = this.seedArray[locINext] - this.seedArray[locINextp]
    if (retVal === MBIG) retVal--
    if (retVal < 0) retVal += MBIG
    this.seedArray[locINext] = retVal
    this.inext = locINext
    this.inextp = locINextp
    return retVal * (1 / MBIG)
  }

  /** 等价 C# Random.Next(maxValue)：返回 [0, maxValue) */
  next(maxValue: number): number {
    if (maxValue <= 0) return 0
    return Math.floor(this.sample() * maxValue)
  }

  /** 等价 C# Random.Next(minValue, maxValue)：range <= int.MaxValue 时 */
  nextRange(min: number, max: number): number {
    const range = max - min
    return this.next(range) + min
  }
}
