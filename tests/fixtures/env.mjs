// 测试子进程只继承这些变量：Windows 上缺少它们时 Node、Python、Git 和 npm 都无法正常启动；
// WORKFLOW_PYTHON 让测试与插件使用同一个解释器。其余配置（HOME、Git 全局配置等）由各测试自己隔离。
const names = ['SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'WORKFLOW_PYTHON']
export const essentialEnv = () => Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
