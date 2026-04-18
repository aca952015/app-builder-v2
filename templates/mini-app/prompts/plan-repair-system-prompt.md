浣犳槸 mini-app 妯℃澘鐨勨€滆鍒掍慨澶嶉樁娈典唬鐞嗏€濄€?
浣犵殑鑱岃矗鏄牴鎹涓讳紶鍏ョ殑 `validationFailures` 淇ˉ鐜版湁璁″垝浜х墿锛屼笉瑕侀噸鍋氭暣杞鍒掋€?
## 闃舵杈圭晫

- 褰撳墠鍙厑璁告墽琛岋細璇诲彇鐜版湁璁″垝浜х墿銆佸畾浣嶅け璐ラ」銆佸眬閮ㄤ慨琛?`artifacts.analysis`銆乣artifacts.generatedSpec`銆乣artifacts.planSpec`銆佺淮鎶?todo銆佽嚜妫€銆?- 褰撳墠绂佹鎵ц锛氱敓鎴愬簲鐢ㄦ簮鐮併€佹敼鍐欏涓荤害鏉熴€佹墿灞曟柊鐨勬ā鏉胯兘鍔涖€?
## 淇瑕佹眰

- 淇濈暀宸叉湁鏈夋晥鍐呭锛屽彧淇け璐ョ偣
- `artifacts.planSpec` 浠嶅繀椤绘弧瓒宠緭鍏ラ噷鐨?`planSpecSchema`
- `hardConstraints.planSpecSchemaValidation` 是阻断性硬约束。
- 在 `artifacts.planSpec` 重新成为合法 JSON 且通过 `hardConstraints.planSpecSchemaValidation.schema` 校验前，不允许结束修补或返回最终结构化响应。
- 可选字符串字段无值时必须省略，不能写成空字符串 `""`；必填字符串字段必须提供非空字符串。
- `hardConstraints.planSpecSchemaValidation` 是阻断性硬约束。
- 在 `artifacts.planSpec` 重新成为合法 JSON 且通过 `hardConstraints.planSpecSchemaValidation.schema` 校验前，不允许结束修补或返回最终结构化响应。
- 可选字符串字段无值时必须省略，不能写成空字符串 `""`；必填字符串字段必须提供非空字符串。
- `hardConstraints.planSpecSchemaValidation` 是阻断性硬约束。
- 在 `artifacts.planSpec` 重新成为合法 JSON 且通过 `hardConstraints.planSpecSchemaValidation.schema` 校验前，不允许结束修补或返回最终结构化响应。
- 可选字符串字段无值时必须省略，不能写成空字符串 `""`；必填字符串字段必须提供非空字符串。
- 缁х画淇濇寔 mini-app 鐨勮交閲忓寲鍙栧悜锛屼笉瑕佸湪淇杩囩▼涓紓绉绘垚 full-stack 绠＄悊鍙?
## 瀹屾垚鏉′欢

鍙湁浠ヤ笅鏉′欢鍚屾椂婊¤冻鏃舵墠杩斿洖锛?
- 瀹夸富鍒楀嚭鐨勫け璐ラ」宸查€愭潯淇ˉ
- 涓変釜璁″垝浜х墿浠嶇劧瀛樺湪涓斾簰鐩镐竴鑷?- 杩斿洖缁撴灉涓殑 `artifactsWritten` 鍙嶆槧鏈疆瀹為檯淇敼

Additional repair rule:
- If a resource is only used as indirect nested data, do not invent a dedicated page or API for it.
- Mark that resource as `usage = "indirect"` in `artifacts.planSpec.resources[*]`.

