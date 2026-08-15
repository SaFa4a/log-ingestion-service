# عدّة النجاة: فيديو العرض + بنك أسئلة المقابلة

## سيناريو فيديو الـ Demo (5 دقائق، مقسّم بالثواني)

**0:00–0:30 — المقدمة**
"هاد مشروع Log Ingestion and Query Service — نظام يستقبل سجلات بمعدل
15,000+ بالثانية، ويخزنها بـ PostgreSQL مقسّمة زمنياً (Range
Partitioning)، وبيوفر استعلام وتجميع سريعين حتى مع مليون+ صف."

**0:30–1:30 — المعمارية (شارك الشاشة على مخطط أو README)**
- اشرح الـ 3 مكونات: Ingestion (Fastify + raw pg + unnest bulk insert)،
  Query (Cursor pagination + composite indexes)، Retention (Daily
  partitions + DROP TABLE).
- اذكر قيود الموارد (0.5 CPU/256MB app، 1 CPU/1GB DB) وكيف أثرت عالقرارات:
  Pool صغير، بدون ORM، partition dropping بدل DELETE.

**1:30–2:15 — القرارات الأساسية الثلاثة (بسرعة، بثقة)**
1. JSONB للـ attributes بدل EAV — صف واحد لكل log.
2. Range Partitioning للـ retention — DROP بدل DELETE.
3. Cursor pagination بدل OFFSET — كلفة ثابتة بغض النظر عن العمق.

**2:15–3:45 — Live Demo**
```bash
docker compose up
curl http://localhost:8080/health
# POST دفعة فيها entry صحيح وentry خاطئ — ورّي الـ rejected بالرد
curl -X POST http://localhost:8080/api/v1/logs -d '{...}'
# GET query بفلتر service + attribute
curl "http://localhost:8080/api/v1/logs/query?service=checkout&attributes.region=eu-west"
# GET aggregate بـ bucket=1h
curl "http://localhost:8080/api/v1/logs/aggregate?start=...&end=...&bucket=1h"
```

**3:45–4:30 — نتائج الأداء (أرقام حقيقية من الـ load test تبعك)**
"حققنا X logs/sec إدخال مستدام، وp95 للـ aggregate كان Y ms — تحت
هدف الثانية الواحدة، حتى أثناء إدخال مستمر."

**4:30–5:00 — القيود المعروفة والخطوات القادمة**
اذكر بصراحة القيد الخاص بفلتر الـ attributes وGIN index (موضح
بالـ README)، وشو ممكن تعمل لو الحجم كبر 10-100 مرة (rollup tables،
promoted columns للمفاتيح الشائعة).

---

## بنك أسئلة المقابلة (Top 10) — مع خطوط الإجابة

**1. ليش JSONB وليس EAV أو عمود نصي للـ attributes؟**
→ EAV بيضاعف عدد الصفوف بالكتابة (أسوأ شي بنظام هدفه 15k/sec إدخال).
عمود نصي ما بيتفهرس. JSONB بيعطيك التوازن: صف واحد، وفهرسة GIN
لعمليات containment مستقبلية، بدون migration لكل مفتاح جديد.

**2. اشرح استراتيجية الـ Retention. ليش partition دوروب مش DELETE؟**
→ DROP TABLE على partition هي عملية Metadata فقط (قفل ACCESS EXCLUSIVE
لأجزاء الثانية)، بينما DELETE بيمسح صف صف، يولّد WAL بقدر الصفوف،
وبيسيب Dead Tuples محتاجة VACUUM — عبء كبير عالمعالج الوحيد المتاح.

**3. ليش Cursor Pagination مش OFFSET/LIMIT؟**
→ OFFSET بيخلي قاعدة البيانات تقرا وترمي كل الصفوف قبل النقطة المطلوبة
— كلفة بتزيد خطياً كل ما تعمّقت الصفحات. Cursor بيحمل آخر (ts, id)
وبيسأل الفهرس "شو بعد هاد مباشرة" — كلفة شبه ثابتة.

**4. ليش Raw SQL مش ORM؟**
→ على 256MB رام، طبقة الـ ORM (query building + object hydration)
عبء إضافي ما منقدر نتحمله. كمان الـ unnest-based bulk insert وpartition-
aware queries أسهل تكتبهم SQL مباشر ومحسّن يدوياً.

**5. اشرح خطة الفهارس تبعتك بالتفصيل.**
→ (service, ts DESC, id DESC) و(level, ts DESC, id DESC) للفلترة
+ الترتيب سوا. (ts DESC, id DESC) للاستعلامات الزمنية البحتة. GIN
trigram لـ substring search على message (B-Tree ما بيقدر يخدم leading
wildcard). GIN jsonb_path_ops على attributes — بس هاد ما بيسرّع فلتر
المساواة المطلوب بالعقد (->>)، بس مفيد لمستقبل containment queries.

**6. شو صار لو الجدول وصل مليار صف؟**
→ partitioning يومي صار مافيه فايدة كبيرة إذا كل partition كبير كتير.
الخطوة القادمة: partitions بالساعة، أو rollup tables مسبقة التجميع
لتقليل الحاجة نمسح البيانات الخام بكل استعلام aggregate.

**7. كيف بتضمن ما يصير SQL Injection رغم إنو الفلاتر ديناميكية؟**
→ كل قيمة بتنضاف كـ parameter مرقّم ($1, $2...) لمصفوفة `params`،
وأبداً ما منعمل string interpolation لقيمة المستخدم داخل نص الـ SQL.
أسماء الأعمدة نفسها (service, level, ts) ثابتة بالكود، مش جايين من
المستخدم.

**8. كيف الـ auth الاختياري ما بيكسر الـ load generator اللي مالوش
config خاص فيك؟**
→ AUTH_ENABLED افتراضياً false — بهالحالة أي Authorization header
بيتجاهل، مش يترفض. لما يتفعّل، الـ master key ينزرع تلقائياً بالـ
startup (idempotent، ON CONFLICT DO NOTHING) قبل ما /health يرجع
جاهز — بدون أي خطوة يدوية.

**9. كيف عملت الـ Bulk Insert بشكل فعّال؟**
→ `unnest` على مصفوفات متوازية (timestamps[], levels[], ...) بطلب SQL
واحد ثابت النص بغض النظر عن حجم الدفعة — هاد بيخلي Postgres يحتفظ
بخطة استعلام واحدة مُخزّنة (Prepared Plan) بدل ما يعيد التحليل كل
مرة بحجم دفعة مختلف.

**10. شو أكبر Bottleneck توقعته أو لاقيته فعلياً؟**
→ (جاوب من نتائج load test الفعلية تبعك — مثال: تشبّع Connection Pool
تحت حمل عالي، أو WAL checkpoint stalls أثناء bulk insert مستمر —
واشرح شو عملت لحلها: زيادة max_wal_size، تصغير/تكبير pool، إلخ).
