// Build langgraph-vs-taor.docx from the markdown source
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = require("docx");
const fs = require("fs");
const path = require("path");

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: "Calibri", size: 22 } },
    },
  },
  sections: [{
    children: [
      // Title
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("LangGraph Pregel vs Taor")] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Agent 循环引擎设计对比")] }),
      new Paragraph({ children: [new TextRun({ text: "作者：左鑫 | 日期：2026-07-08 | github.com/Tubo2333/taor", italics: true, color: "888888" })] }),
      new Paragraph({ spacing: { after: 300 }, children: [] }),

      // Section helper
      h2("开篇：两句话讲清楚两个框架"),
      p("想象你是一个包工头，要指挥一群工人盖房子。"),
      p(""),
      p([bold("LangGraph（Pregel 模型）"), "：你把所有工人叫到工地上，说：这一轮，砌墙的砌墙，搬砖的搬砖，你们同时干。等所有人都干完了，我检查一下进度，再分配下一轮的任务。——这就是 Superstep（超级步），一轮内所有人并行，轮与轮之间统一同步。"]),
      p(""),
      p([bold("Taor（TAOR 模型）"), "：你走到砌墙工人面前说：砌这面墙——看他砌完——检查质量——根据结果决定下一步。发现问题了？立刻停下来问你要不要换方案。这就是 Think — Act — Observe — Repeat，每一步串行，但每一步都有人盯着。"]),
      p(""),
      p("两种方式没有绝对的好坏，看场景。"),

      // Section 1
      h2("一、循环模型对比"),

      h3("LangGraph：Superstep = 批量并行"),
      p("LangGraph 把一次循环叫一个 Superstep。分三个阶段："),
      p("  Plan（决定执行哪些 node）— Execute（所有 node 并行跑）— Update（写 channel + checkpoint）"),
      p(""),
      p([bold("核心逻辑"), "：prepare_next_tasks() 检查哪些 channel 被更新了 — 触发订阅了这些 channel 的 node — 所有被触发的 node 放入 Executor 线程池并行执行。全部完成后，统一写 checkpoint，进入下一个 Superstep。"]),
      p(""),
      codeBlock(`# _algo.py: prepare_next_tasks()
def prepare_next_tasks(checkpoint, pending_writes, processes, channels, ...):
    tasks = []
    # 1. 消费排队的 PUSH 任务（Send 过来的）
    for task in consume_pending_tasks():
        tasks.append(task)
    # 2. 找出被更新的 channel —> 触发订阅 node
    for channel in updated_channels:
        triggered_nodes.update(trigger_to_nodes[channel])
    # 3. 为每个触发的 node 准备任务（放入 Executor 并行执行）
    for name in triggered_nodes:
        if task := prepare_single_task(name, ...):
            tasks.append(task)
    return tasks  # 这批 tasks 全部并行执行`),

      h3("Taor：Turn = 串行事件流"),
      p("Taor 的一次循环叫一个 Turn，用 AsyncGenerator 状态机驱动。三个阶段："),
      p("  THINK（调 LLM，流式接收）— ACT（逐个执行工具，权限检查 + 审批暂停 + 错误恢复）— OBSERVE（累积 token + 压缩上下文）"),
      p(""),
      codeBlock(`// harness.ts: runTAOR() — 一个 Turn 的完整流程
private async runTAOR(): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    // === THINK: 流式接收 LLM 思考 ===
    for await (const event of this.adapter.think(request, signal)) {
      if (event.type === "tool_use") this.pendingToolCalls.push(event.call)
    }

    // === ACT: 逐个执行工具 ===
    for (const tc of this.pendingToolCalls) {
      // 1. 权限检查
      const verdict = this.permission.evaluate(tc.name, tc.args)
      if (verdict.level === "deny") continue

      // 2. 需要审批？暂停，等用户决定
      if (needsApproval) await this.waitForDecision()

      // 3. 执行 + 五级错误恢复
      try { result = await tool.execute(params, ctx) }
      catch (err) { /* retry / skip_turn / abort / ignore / mark_failed */ }
    }

    // === OBSERVE: 累积 token，触发压缩 ===
    if (totalTokens > threshold) this.compressor.compress(ctx)
  }
}`),

      // Comparison table
      table(
        ["维度", "LangGraph Pregel", "Taor"],
        [
          ["循环单元", "Superstep（批量并行）", "Turn（串行事件流）"],
          ["并行策略", "同一 Superstep 内 node 并行执行", "tool 逐个串行；子 Agent 可 process.fork 并行"],
          ["任务触发", "Channel 订阅，自动触发下游 node", "LLM 思考决定下一步调用哪些 tool"],
          ["暂停/恢复", "Checkpoint 序列化整个 state", "AsyncGenerator 自然暂停 + serialize/deserialize"],
          ["最小运行", "~50 行 Python", "~30 行 TypeScript"],
        ],
      ),

      // Section 2
      h2("二、任务调度对比"),

      h3("LangGraph：Channel 订阅 — 自动触发"),
      p("Node A 的输出写入 Channel X — 订阅了 Channel X 的 Node B 自动被触发。一个 node 的输出可能同时触发多个下游 node，在同一个 Superstep 内并行执行。这就是 LangGraph 的扇出能力。"),
      p(""),
      p("像多米诺骨牌——推倒一个，自动触发一串。适合预设好的多步工作流。"),

      h3("Taor：事件流 — LLM 动态决策"),
      p("Taor 没有自动触发机制。LLM 在 THINK 阶段决定调用哪些 tool，ACT 阶段逐个执行。Tool 之间不自动通信——它们通过 LLM 在下一轮 THINK 时观察上一轮的结果来决定下一步。"),
      p(""),
      p("像下棋——LLM 走一步，框架执行，LLM 看局面再决定下一步。适合需要动态推理的场景。"),

      // Section 3
      h2("三、错误恢复对比"),

      h3("LangGraph：声明式重试"),
      p("LangGraph 的 node 可以声明 retry_policy（最大次数、指数退避）。失败后自动重试，全部失败则抛异常，整个 graph 中断。简单直接，但只能重试，不能跳或降级。"),
      p(""),
      h3("Taor：五级恢复策略"),
      p("Taor 用 onError 钩子让程序员根据错误类型选择策略："),
      p("  1. retry —— 重试（最多 3 次），适合临时性错误（如 502 网关超时）"),
      p("  2. skip_turn —— 跳过这轮，适合「这一次失败但下一次可能成功」的情况"),
      p("  3. abort —— 中止整个会话，适合不可恢复的错误（如权限被拒）"),
      p("  4. ignore —— 忽略错误继续执行，适合非关键步骤"),
      p("  5. 重试耗尽 — 标记失败，记录日志但不中断会话"),
      p(""),
      p([bold("关键差异"), "：LangGraph 给你一个重试按钮，按三次还不行就炸了。Taor 给你五个选项。"]),

      // Section 4
      h2("四、权限模型——Taor 的最大差异化优势"),

      h3("LangGraph：没有原生权限系统"),
      p("如果你想限制某个 node 不能读 /etc/ 下的文件，需要在 node 函数里自己写 if 判断。就像门上没有锁，每次进门前都要自己检查'有没有坏人跟进来了'。"),

      h3("Taor：4 级权限引擎 + @resource 边界约束"),
      p("独立的 PermissionEngine 类，四个权限级别："),
      p("  deny —— 直接拒绝（如禁止 rm -rf /）"),
      p("  boundary —— 只在越界时拦截（读 /app/config.json 放行，读 /etc/secrets.env 拦截）"),
      p("  allow —— 直接放行（如读 /tmp/debug.log）"),
      p("  ask —— 每次都问用户（如执行任意 shell 命令）"),
      p(""),
      p("工具声明时加 @resource file 注解，配置里声明 denylist/allowlist，框架自动拦截。权限逻辑不侵入业务代码。"),
      p(""),
      p([bold("这是 LangChain/LangGraph 生态里没有人做的事。"), "对 AI for Science、金融、医疗等需要审计的场景，是刚需。"]),

      // Section 5
      h2("五、生命周期钩子对比"),

      h3("LangGraph：有限的事件回调"),
      p("LangGraph 的 callbacks 继承自 LangChain：on_chain_start/end、on_tool_start/end 等。不是专门为 Agent 循环设计的，拼凑感强。"),

      h3("Taor：13 点生命周期钩子"),
      p("专为 TAOR 循环原生设计，覆盖整个 Think-Act-Observe 流程："),
      p("  onSessionStart — beforeThink — afterThink — beforeAct — afterAct — afterObserve"),
      p("  — onError — beforeCompress — afterCompress — onSessionEnd （共 13 点）"),
      p(""),
      p("插件式扩展，hook handler 写在外部，注入到 Harness 中，不修改核心代码。"),

      // Section 6
      h2("六、状态管理对比"),

      h3("LangGraph：Checkpoint = 全量快照"),
      p("每个 Superstep 结束后，自动保存所有 channel 的值、node 状态、pending writes。像游戏存档，恢复时加载 checkpoint 从中断的地方继续。支持 SQLite/Postgres 多种后端。"),

      h3("Taor：轻量序列化 = 消息历史快照"),
      p("只保存消息历史和 turn 记录。设计哲学：消息历史本身就是 Agent 所需的全部 state。像聊天记录——轻量，适合 LLM Agent 的任务场景。"),

      // Section 7
      h2("七、完整对比表"),

      table(
        ["维度", "LangGraph Pregel", "Taor"],
        [
          ["核心模型", "BSP（批量同步并行）", "TAOR（串行事件流）"],
          ["执行方式", "Superstep 内 node 并行", "Turn 内 tool 串行"],
          ["并行手段", "线程池自动调度", "child_process.fork 子 Agent"],
          ["任务触发", "Channel 订阅自动触发", "LLM 决定 — 框架执行"],
          ["状态保存", "Checkpoint 全量快照", "消息序列化"],
          ["权限系统", "无原生支持", "4 级权限 + @resource 约束"],
          ["错误恢复", "声明式 retry_policy", "五级恢复（重试/跳过/降级/中止/忽略）"],
          ["生命周期钩子", "LangChain 回调（有限）", "13 点专为 Agent 循环设计"],
          ["上下文压缩", "依赖外部工具", "5 层内置压缩 pipeline"],
          ["OpenTelemetry", "需手动集成", "内置 otel-hooks"],
        ],
      ),

      // Section 8
      h2("八、LangGraph 做得比 Taor 好的地方"),
      p([bold("1. Checkpoint 机制更成熟。"), "多年打磨，支持 SQLite/Postgres，增量快照和跨会话恢复。Taor 的序列化还比较基础。"]),
      p(""),
      p([bold("2. 并行执行模型更适合复杂 DAG。"), "如果你的工作流是先同时从 5 个 API 取数据—汇总—同时生成 3 份报告，LangGraph 的 Superstep 并行模式天然适合。"]),
      p(""),
      p([bold("3. 生态和社区。"), "LangGraph 背靠 LangChain，10 万+ GitHub star。但企业用 LangGraph 过程中最痛的三个问题（权限、上下文污染、子 Agent 隔离）——恰好是 Taor 解决的。"]),

      // Section 9
      h2("九、Taor 做得比 LangGraph 好的地方"),
      p([bold("1. 原生权限引擎。"), "LangChain 生态里没有人做这个。对 AI for Science、金融、医疗等需要审计的场景，是硬需求。"]),
      p(""),
      p([bold("2. 更轻量的状态机模型。"), "AsyncGenerator 让 Agent 循环天然可暂停可恢复，不需要理解 BSP 和 channel 语义。30 行代码就能跑起来。"]),
      p(""),
      p([bold("3. 面向生产的错误恢复。"), "五级恢复不是更好的重试，而是让你根据错误类型选择策略——这是生产环境 Agent 的真实需求。"]),

      // Section 10
      h2("十、如果重新设计 Taor，我会改什么"),
      p([bold("1. 加一个扇出模式。"), "当前 tool 全部串行，如果 LLM 说同时查这 5 篇文献，应该支持 parallel 模式在 Turn 内并行执行。"]),
      p(""),
      p([bold("2. Checkpoint 引入增量保存。"), "消息多了全量序列化会很慢，LangGraph 那种 channel 级别的增量版本号机制值得借鉴。"]),
      p(""),
      p([bold("3. Adapter 层再抽象一层。"), "共用逻辑（token counting、tool formatting）抽到基类，减少 adapter 的重复 boilerplate。"]),
      p(""),
      p([bold("4. 权限做到参数级粒度。"), "比如WriteFile 可以写 /app/ 但不能超过 1MB。"]),

      // Afterword
      p(""),
      p(""),
      p([
        bold("后记："),
        "这篇对比不是为了证明谁更好。LangGraph 是一个优秀的框架，背后有世界级的工程团队。",
        "Taor 是一个研究生在几个月里写的——但它证明了：",
        bold("理解一个系统的核心设计，和亲手实现它，是完全不同的两件事。"),
        "前者让你成为会用的人，后者让你成为会设计的人。",
      ]),
    ],
  }],
});

// Helper functions
function p(content) {
  if (typeof content === "string") {
    return new Paragraph({ children: content ? [new TextRun(content)] : [] });
  }
  if (Array.isArray(content)) {
    return new Paragraph({ children: content.flat() });
  }
  return new Paragraph({ children: [] });
}

function bold(text) {
  return new TextRun({ text, bold: true });
}

function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 400, after: 200 }, children: [new TextRun(text)] });
}

function h3(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 300, after: 100 }, children: [new TextRun(text)] });
}

function codeBlock(code) {
  return new Paragraph({
    spacing: { before: 100, after: 100 },
    shading: { type: "solid", fill: "F0F0F0" },
    children: [new TextRun({ font: "Consolas", size: 18, text: code })],
  });
}

function table(headers, rows) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(h =>
      new TableCell({
        width: { size: 3000, type: WidthType.DXA },
        shading: { fill: "2B579A" },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF", size: 20 })] })],
      })
    ),
  });
  const dataRows = rows.map(row =>
    new TableRow({
      children: row.map((cell, i) =>
        new TableCell({
          width: { size: 3000, type: WidthType.DXA },
          shading: { fill: i === 0 ? "F2F6FC" : "FFFFFF" },
          children: [new Paragraph({ children: [new TextRun({ text: cell, size: 20 })] })],
        })
      ),
    })
  );
  return new Table({ rows: [headerRow, ...dataRows], width: { size: 100, type: WidthType.PERCENTAGE } });
}

// Build
Packer.toBuffer(doc).then(buf => {
  const out = path.join(__dirname, "langgraph-vs-taor.docx");
  fs.writeFileSync(out, buf);
  console.log("Done:", out, `(${(buf.length / 1024).toFixed(1)} KB)`);
}).catch(err => {
  console.error("Build failed:", err.message);
  process.exit(1);
});
