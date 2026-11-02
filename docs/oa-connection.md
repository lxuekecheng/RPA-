# ITSM 直接读取与余额核验

实际内网地址和定位器位于 .local/oa.json，空白示例为 config/oa.example.json。

浏览器沿用 Windows 和 VPN 已有的网络设置，程序不设置代理参数或强制直连。此前临时添加的 network.mode 和 --no-proxy-server 已撤销。显式指定某个代理得到 502，只能证明该次请求失败，不能据此判断 Chrome 经系统设置和 VPN 的实际访问路径，也不能将第二条预算报错确定归因于代理。

## 来源配置

source.kind = oa；source.verified 只有实际验证分页读取和余额核验后才能启用。source.year 为默认年度；source.blankAllocatedAsZero = true 表示用户已确认已分摊和在途空白按 0 计算。

读取按钮调用本机 POST /api/oa/scan，参数为 year。浏览器自动打开合同表单和项目编号关联列表，按年度筛选、完整翻页、核对总数，再在本机精确筛选收费属性。页面不提供文件上传，POST /api/preview 已关闭；GET /api/preview 只读取最近预览。

## 页面 DOM

表单在 #zwIframe；关联列表在顶层 layui-layer iframe。Target 使用标准 CSS selector 和 frameChain，每步必须唯一。可选 fieldLabel 按隐藏 .field-title 或可见表格标签精确匹配 .cap-field，再在字段内应用 selector；重名或缺失时停止，不按位置猜测。

表头依据可见中文名称映射：年度、费用说明、分摊合计含税、预算编号、预算名称、收费属性、已分摊合同金额、在途分摊合同金额。通过单元格 DOM 的 title 或完整文本读取，避免截图省略文字。

picker.yearInput、searchInput、searchButton 分别对应年度、编号和筛选按钮；nextPage 为下一页；cancel 用于读取后关闭弹窗。分页核对页号、首行变化、记录总数及重复编号。

每次打开关联列表，先等待年度、编号和筛选控件可操作，再主动筛选；筛选响应之后才要求分页与行数完全一致。初始旧行数或缓存页码不能阻止本次筛选，查询结果仍保留严格的完整性和余额核验。

picker.queryResponsePath 仅用于等待浏览器点击筛选/翻页后产生的真实响应完成。程序不直接调用该 ITSM 接口，也不读取 Vue 内部数据。

收到 HTTP 200 仍要检查 response.finished() 是否返回 Error，以识别响应体中途断开。相同条件的只读筛选遇到连接中断、超时或 HTTP 408/502/503/504 时最多重试一次；分页和保存不自动重试。金额或结果完整性异常直接停止。

ITSM 旧脚本覆盖 Set，src/dom-locator.mjs 使用 DOM 查询和协议鼠标键盘事件适配，不修改网页全局对象。

## 余额和两次核验

src/oa-budget.mjs 负责精确整数分计算。normalizeOaRow 生成三项金额、余额、异常和跳过原因；makeOaPreview 仅保留目标收费属性及年度；assertSameOaBalance 比较实时数据与预览快照。

选中预算时重新筛选年度和编号，要求只匹配一条，并核对收费属性、名称、说明和三项金额。填写后再次打开关联列表查询同一预算，核对后点取消，回到表单再回读所有填写值。金额或其他关键数据变化时，在保存前停止。浏览器操作不能形成跨用户数据库事务，服务不承诺阻止其他人员在核验后同时修改 ITSM 数据。

## 填写和保存

合同名称为“当年年份＋年信息化分摊费用＋项目名称”，说明为“当年年份＋年信息化分摊费用”。年份按北京时间执行日期确定，不使用预算记录年度。public/contract-rules.js 同时供页面预览和后端构建合同使用；实时核验快照保留原始预算说明，与新生成的合同说明分开。

CAP4 单选已经选中时不可再次点击，避免取消；合同内容跳过空白选项；公章保管类型精确选择“公司保管合同章”。日期 id 随焦点变化，按字段容器定位首个 input。预审领导、我方负责人联系方式、上传合同保留表单原值，自动带出非空内容时继续录入，不再要求配置这三项定位器。旧配置中的 fields.leaveBlank 会被忽略。

2026-10-29 用户明确更正复制方向：receivingContact（下方收款联系人）、receivingEmail（下方收款联系人邮箱）是来源，counterpartyOwner（上方对方负责人）、counterpartyContact（上方对方负责人联系方式）是目标。实际 DOM 中联系人来源为 #field1421_id .cap4-people__text 展示 div，邮箱来源为 #field1427_id input；上方两个目标为 #field0026_id input、#field0028_id input。通过真实键盘输入并失焦填写目标，不尝试修改姓名来源的展示 div，不打开选人弹窗。每项独立处理空值，来源为空时目标清空；来源或目标回读变化时停止。

save.mode = seeyon-wait-send：

1. 核对余额、已填写的表单字段、固定选项、关联公司和收款复制字段。
2. 仅允许文字为“保存待发”或“暂存待发”的按钮。
3. 读取待保存 id，await beforeSave({ expectedDraftId }) 同步落盘。已处于同一待发草稿页时阻止重复保存。
4. 同时观察主页面、iframe 的已提交地址并捕获弹窗，只点击一次保存。不使用 waitForNavigation(domcontentloaded) 作为保存成功条件。
5. 草稿凭据须同源、匹配合同页面路径及 method、from=waitSend，summaryId 与保存前一致，affairId 为非空数字标识。
6. 重新 GET 已观测到的草稿地址，waitUntil=commit 后确认 HTTP 成功、页面仍匹配该草稿，并逐项回读字段。输入页面的旧值或成功提示不能代替持久保存证明。

超时或不匹配都标记待核查，不自动再次保存或创建。原生弹窗及可见的 alert/dialog 提示会记录到错误，历史保留 expectedDraftId、observedUrl 和已取得的草稿凭据，便于核查。旧版 uncertain 记录若没有这些证据，不能因本次修复自动解锁重试。年度和编号保持历史身份，不因来源从文件改为 ITSM 而丢失防重记录。已保存记录即使余额变化也继续跳过，避免草稿尚未计入在途时重复创建。

服务在整批每条保存凭据均确认、历史均写入 saved 后，调用 closeEntryPage 关闭最后的合同录入页，保留主页及浏览器会话。失败、结果不确定或中途停止时不关闭；关闭失败只记录提示，已保存状态不会回滚或重新保存。
