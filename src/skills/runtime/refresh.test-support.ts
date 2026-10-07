import "./refresh.js";

type SkillsRefreshTestApi = {
  resetSkillsRefreshForTest(): Promise<void>;
  setNativeSkillsWatchOverrideForTest(forced: "on" | "off" | undefined): void;
};

function getTestApi(): SkillsRefreshTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.skillsRefreshTestApi")
  ] as SkillsRefreshTestApi;
}

export async function resetSkillsRefreshForTest(): Promise<void> {
  await getTestApi().resetSkillsRefreshForTest();
}

// 让测试显式声明"这批用例要测 chokidar 路径"还是"要测原生 fs.watch 路径",
// 不依赖宿主机真实 process.platform(本仓 CI 跑 ubuntu,原生路径在那永远不会
// 触发;本地在 macOS/Windows 开发机上跑同一批老测试则会真的触发,所以必须
// 显式控制,不能两边各自隐性假设)。
export function setNativeSkillsWatchOverrideForTest(forced: "on" | "off" | undefined): void {
  getTestApi().setNativeSkillsWatchOverrideForTest(forced);
}
