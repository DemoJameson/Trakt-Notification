import { defineConfig } from 'vitest/config'

/**
 * 两个设置，都是为了**确定的测试收集**。
 *
 * 现象：默认配置下跑全量，偶尔会**整份漏掉一个测试文件**（routes 83 项、
 * integration 45 项轮着来），结果里没有任何一条失败，只是总数少一截 ——
 * 极易被误判成「我刚删了用例」或「测试不稳定」。
 *
 * 原因：默认的 `threads` 池在 `node_modules/.vitest` 下写临时 SSR 文件，
 * 这台 Windows 机器上偶发 `EPERM`（文件被占用）。
 *
 * `pool: 'forks'` 避开那批临时文件；`fileParallelism: false` 再把文件之间
 * 串行化，连"并发抢资源"这条路也堵上。代价是慢一点（测试量小，可接受）。
 * 确定性比速度重要 —— 收集数会飘的话，「全量通过」这个结论本身就不可信。
 */
export default defineConfig({
  test: {
    pool: 'forks',
    fileParallelism: false,
  },
})
