# IEEE 项目授权请求（PAR）答复稿

**对应标准：** Analyzable Encrypted File Format（AEFF，可分析加密文件格式）  
**文档标识：** YEEZ-AEFF-FORMAT-ZH（草案 v0.2.0）  
**参考实现：** [meta-encryptor](https://github.com/YeeZTech/meta-encryptor)（YeeZ Tech）  
**编制说明：** 下列带「待 Sponsor 填写」的栏位需在正式提交 IEEE-SA 前由发起方补全。

---

## Section 1

### 1.1 Assigned Project Number（指定项目编号）

**待 Sponsor 填写**（IEEE-SA 分配后填入，例如 P####）。

### 1.2 Type of Document（文档类型）

**Standard（标准）**

### 1.3 Life Cycle（生命周期）

**Full Use（完整使用）**

---

## Section 2

### 2.1 Project Title（项目标题）

**英文（建议正式标题）：**

> IEEE Standard for Analyzable Encrypted File Format (AEFF)

**中文（工作标题）：**

> 可分析加密文件格式（AEFF）标准

**说明：** AEFF 定义后缀为 `.aeff` 的可分析加密文件容器格式，支持块级随机访问、分段认证加密、可选多文件目录树索引，适用于隐私计算与数据交付场景。

---

## Section 3

### 3.1 Working Group（工作组）

**待 Sponsor 填写**（建议名称示例：*AEFF Working Group* 或 Sponsor 下设之 *Data Seal Format Working Group*）。

### 3.2 Sponsoring Society and Committee（发起学会与委员会）

**待 Sponsor 填写**（例如：IEEE Computer Society / 相应 Standards Committee，以 Sponsor 实际归属为准）。

### 3.3 Joint Sponsor（联合发起方）

**None（无）**

---

## Section 4

### 4.1 Sponsor Balloting Information（发起方投票信息）

**Individual（个人投票）**

### 4.2 Expected Date of Submission of Draft to the IEEE-SA for Initial Sponsor Ballot  
（预计向 IEEE-SA 提交草案以启动 Sponsor Ballot 的日期）

| 字段 | 值 |
|------|-----|
| Month（月） | **待 Sponsor 填写** |
| Year（年） | **待 Sponsor 填写** |

**建议：** 可在草案 v0.2.0 完善（样例文件、互操作矩阵、v0.1→v0.2 兼容细则等占位内容补齐）并完成 Sponsor 内部审阅后，再确定具体月份。当前草案尚有多处「占位 / 暂定」条目。

### 4.3 Projected Completion Date for Submittal to RevCom  
（预计提交 RevCom 的完成日期）

| 字段 | 值 |
|------|-----|
| Month（月） | **待 Sponsor 填写** |
| Year（年） | **待 Sponsor 填写** |

**建议：** 通常较 4.2 晚 6–12 个月，视 Sponsor Ballot、评论轮次及修订工作量而定。

---

## Section 5

### 5.1 Approximate number of people expected to be actively involved in the development of this project  
（预计积极参与本项目开发的人数）

**约 5–10 人**

**构成（草案）：** 格式规范作者、参考实现（Meta-Encryptor）维护者、安全/密码学审阅者、隐私计算平台集成工程师、文档与互操作测试负责人。具体名单由 Sponsor 工作组在 PAR 批准后确定。

### 5.2 Scope of the proposed standard（拟议标准的范围）

本标准规定 **Analyzable Encrypted File Format（AEFF）** 的二进制文件格式，文件后缀为 `.aeff`。AEFF 是一种面向隐私计算与数据交付的密文容器格式，在提供机密性、完整性与逐 Item 认证加密的前提下，内建块级索引与尾部元数据，支持**不解封整包**条件下的块级/Item 级随机访问与局部校验，并可选携带目录树明文以索引多个逻辑文件。

**本标准规定（规范性）：**

- 文件三区布局：Content Region（内容区）、Block Infos（块索引区）、Header（80 字节尾部头）；
- Header、Block Info、Item 及 `cipher_payload` 的字段布局、字节序与校验规则；
- 密码学边界（算法无关原则、随机性要求、认证失败语义等）；
- 目录树明文格式的二进制布局、解析与校验；
- 兼容性与版本识别规则；
- 一致性测试要求及标准错误码。

**本标准不规定：**

- 上层业务协议、应用层权限模型；
- 记录级（L3）结构化索引表格式；
- 具体的椭圆曲线、AEAD、KDF 实现细节（当前版本 v2 的参考密码学套件以附录形式给出，供互操作参考）；
- 封装/解封流程的内部数据结构（读指针、队列等），除明确援引格式条款外，附录流程为参考性说明。

**适用对象：** 读写 `.aeff` 文件的实现，包括但不限于 Node.js 与浏览器环境；参考实现为 YeeZ Tech 的 Meta-Encryptor 生态。

### 5.3 Is the completion of this standard contingent upon the completion of another standard?  
（本标准完成是否取决于另一项标准？）

**No（否）**

AEFF 为独立的文件格式标准。附录中引用的密码学原语（如 AES-GCM、secp256k1、Keccak-256 等）均来自已有公开规范，不依赖某一项尚未发布的 IEEE 标准完成。

### 5.4 Will this document contain a Purpose clause?  
（本文档是否包含 Purpose 条款？）

**No（否）**

草案采用「引言（背景与动机、目的、范围）」结构，未单独设置 IEEE 惯用之 Purpose 独立条款；**目的**已在引言 §1.3 中表述：定义 `.aeff` 二进制结构、密码学边界、兼容性规则与一致性要求，确保互操作性与可验证性。

### 5.5 Need for the project（项目需求）

隐私计算与数据交付场景中，密文容器除机密性、完整性外，还须支持**随机访问**：在不解封整包的前提下，定位并读取、校验其中一段内容，以满足审计、抽样与数据分析等需求。

现有常见形态存在不足：

- **整文件单一密文**（如 OpenSSL enc、一次性对称加密）：密文流不携带可用于定位与分段校验的结构信息，随机访问成本高；
- **先归档再整体加密**（tar/zip 后加密）：解密前无法获知内部成员边界，无法对单个成员做认证级局部读取；
- **单管线消息型密文**（如 OpenPGP 单文件输出）：通常不提供内建随机访问语义；
- **仅支持顺序解密的密封容器**：若依赖外部偏移表，索引与密文载体易脱节，版本不一致。

AEFF 在同一格式内提供尾部 Header、Block 索引、分段认证加密的内容区及可选目录树，使数据分析等场景可在不整包解封的前提下按块定位读取并校验，多逻辑文件关系由目录树描述。YeeZ Tech 在典枢/Fidelius 隐私计算链路中已有 Meta-Encryptor 参考实现与生产实践，亟需将现有 `.aeff` 格式上升为可互操作的公开标准，以避免实现分叉与索引—载体脱节风险。

### 5.6 Stakeholders for the standard（标准利益相关方）

- **文件格式实现者**：开发 AEFF 读写库、SDK 的厂商与开源社区；
- **隐私计算平台运营方**：托管、交付、审计加密数据的平台（如典枢生态）；
- **安全审计人员**：需验证密文完整性与格式合规性的第三方审计方；
- **平台集成与运维工程师**：在 Node.js、浏览器等环境部署加解密链路的工程团队；
- **隐私计算数据处理链路设计人员**：设计密封、解封、抽样分析流程的架构师；
- **数据提供方与使用方**：在本地完成加密托管、在本地解封的业务用户；
- **参考实现维护者**：Meta-Encryptor（`@yeez-tech/meta-encryptor`）及基于其的集成应用开发者。

---

## Section 6

### 6.1 Intellectual Property（知识产权）

#### A. Is the Sponsor aware of any copyright permissions needed for this project?  
（发起方是否知晓本项目需要任何版权许可？）

**No（否）**

草案正文由 YeeZ Tech 基于自有 Meta-Encryptor 实践编写；参考实现以 MIT 许可证开源。标准中引用的 RFC 2119 关键词、公开密码算法与常数均为公开文献。发起方目前**未识别**需要额外版权许可的第三方受版权保护材料嵌入标准正文。

#### B. Is the Sponsor aware of possible registration activity related to this project?  
（发起方是否知晓与本项目相关的可能的注册活动？）

**No（否）**

发起方目前**未识别**与 AEFF 格式名称、`.aeff` 后缀或相关商标/专利注册活动的已知冲突；正式 PAR 提交前仍应进行 Routine IP 检索（含「AEFF」「Analyzable Encrypted File Format」等）。

---

## Section 7

### 7.1 Are there other standards or projects with a similar scope?  
（是否存在范围类似的其他标准或项目？）

**No（否）** — *就 IEEE  PAR 表单之狭义理解：无与 AEFF 范围实质等同的已发布 IEEE 标准。*

**补充说明（见 §8.1）：** 存在**相关但范围不同**的标准与常见实践，例如 OpenPGP（RFC 4880）、CMS/PKCS#7、ZIP/TAR 加密容器、OpenSSL enc 等；上述标准均**未**在单一文件格式内同时标准化 AEFF 所定义的「尾部元数据 + 块索引 + 分段认证 Item + 可选目录树 + 块级随机访问」组合语义。AEFF 填补的是该交叉能力缺口，而非替代现有通用加密或归档标准。

### 7.2 Joint Development — Is it the intent to develop this document jointly with another organization?  
（是否打算与其他组织联合开发本文档？）

**No（否）**

当前由 Sponsor 工作组主导开发；欢迎外部实现者参与评论与互操作验证，但**无**正式联合开发（Joint Development）安排。

### 7.3 International Standards Activities（国际标准活动）

#### A. Adoptions — Is there potential for this standard to be adopted by another organization?  
（本标准是否有被其他组织采纳的潜力？）

**No（否）**

暂无已确认的第三方标准组织采纳计划；若后续有 ISO/IETF/国内标委采纳或对照需求，可在标准稳定后再行评估。

#### B. Harmonization — Are you aware of another organization that may be interested in portions of this document in their standardization development efforts?  
（是否知晓其他组织可能对本文件部分内容的标准化工作感兴趣？）

**No（否）**

目前**无**已确认的外部组织协调意向；隐私计算与数据安全领域组织可能对「可随机访问的加密文件容器」章节产生兴趣，但尚未进入正式协调。

### 7.4 Does the sponsor foresee a longer term need for testing and/or certification services to assure conformity to the standard?  
（发起方是否预见需要长期测试和/或认证服务以保证符合性？）

**No（否）**

Additionally, is it anticipated that testing methodologies will be specified in the standard to assure consistency in evaluating conformance to the criteria specified in the standard?  
（此外，是否预期在标准中规定测试方法以评估符合性？）

**No（否）**

草案第 11 章列出**最小一致性测试集**（头字段解析、加解密回环、篡改检测、中断恢复、跨端一致性等），并计划补充二进制样例与互操作矩阵，但**不**打算在标准中规定正式认证计划或第三方测试实验室制度。符合性评估预期由实现者自行测试及生态内互操作测试完成。

---

## Section 8

### 8.1 Additional Explanatory Notes（补充说明）

以下按 PAR 条目编号列出，供 NesCom 审阅参考。

**Item 2.1 — 项目标题**  
英文工作标题建议与文档元数据一致：*IEEE Standard for Analyzable Encrypted File Format (AEFF)*。中文草案标题见仓库 `doc/sealed-format-standard-zh.tex`（文档标识 YEEZ-AEFF-FORMAT-ZH，当前 v0.2.0 草案）。

**Item 5.2 — 范围**  
标准正文区分「规范性格式/校验」与「参考性附录」：正文第 5–7 章及密码学边界为 MUST/SHOULD/MAY 约束；附录 F（v2 密码学套件）、附录 G（多文件编排）、附录 H（封装/解封流程）以参考为主，便于 Meta-Encryptor 生态互操作，但不强制具体实现算法或内部数据结构。

**Item 5.5 — 项目需求**  
参考实现 Meta-Encryptor 已用于典枢数据托管与 Fidelius 隐私计算链路（见 `README.md`）。标准上升旨在避免各实现对外部索引的依赖及格式分叉。

**Item 7.1 — 类似范围标准**  
虽无等同 IEEE 标准，实现者与审阅者应知悉以下相关公开规范（**非** AEFF 互操作替代）：
- RFC 4880（OpenPGP）
- NIST SP 800-38D（GCM）、SEC 1（椭圆曲线）
- ZIP/TAR 及常见整文件加密工具

**Item 4.2 / 4.3 — 时间表**  
草案 v0.2.0 尚待补齐：§9.2 v0.1（64B Header）→ v0.2（80B Header）互操作细则；§11.2 二进制样例；§11.3 互操作矩阵；附录 G 多文件流程图及扩展错误码；§7 目录树魔数/版本「暂定」参数.finalize。上述完成后方可 realistic 设定 Sponsor Ballot 与 RevCom 日期。

**引用文档清单：**

| 标题 | 位置 |
|------|------|
| 可分析加密文件格式（AEFF）中文标准草案 v0.2.0 | `doc/sealed-format-standard-zh.tex` / `doc/sealed-format-standard-zh.pdf` |
| Meta-Encryptor 参考实现 | https://github.com/YeeZTech/meta-encryptor |
| Recoverable 断点续传待办（实现侧，非标准正文） | `docs/recoverable-stream-todo.md` |

### 8.2 IEEE Code of Ethics（IEEE 道德准则）

**待 PAR 提交负责人在 IEEE 在线系统中勾选确认：**

- [ ] I acknowledge that I have read and I understand the IEEE Code of Ethics  
- [ ] I agree to conduct myself in a manner that adheres to the IEEE Code of Ethics when engaged in official IEEE business.

（本人确认已阅读并理解 IEEE 道德准则；本人同意在从事 IEEE 官方事务时遵守该准则。）

**PAR 提交负责人：** **待 Sponsor 填写（姓名 / 职务 / 联系方式）**

---

## 附录：PAR 字段速查表

| 条目 | 答复摘要 |
|------|----------|
| 1.1 项目编号 | 待 IEEE-SA 分配 |
| 1.2 文档类型 | Standard |
| 1.3 生命周期 | Full Use |
| 2.1 标题 | IEEE Standard for Analyzable Encrypted File Format (AEFF) |
| 3.3 联合发起 | None |
| 4.1 投票方式 | Individual |
| 5.1 预计人数 | 5–10 人 |
| 5.3 依赖其他标准 | No |
| 5.4 Purpose 条款 | No |
| 6.1A 版权许可 | No |
| 6.1B 注册活动 | No |
| 7.1 类似范围标准 | No（无等同 IEEE 标准；有相关但不同范围规范） |
| 7.2 联合开发 | No |
| 7.3A 采纳潜力 | No |
| 7.3B 协调兴趣 | No |
| 7.4 测试/认证 | No / No |

---

*文档版本：PAR 答复稿 v0.1 | 对应 AEFF 标准草案 v0.2.0*
