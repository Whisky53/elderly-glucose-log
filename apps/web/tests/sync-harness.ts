/**
 * 端到端验证用的打包入口：把前端真实的本地仓库与同步引擎暴露给 Node 测试脚本。
 * 只做导出，不含任何业务逻辑，因此不会影响生产产物。
 */
export * from '../src/data/local/repo';
export {
  sync,
  planSaveMutation,
  planDeleteMutation,
  planRestoreMutation,
} from '../src/data/sync/engine';
export { api, ApiError } from '../src/data/api/client';
