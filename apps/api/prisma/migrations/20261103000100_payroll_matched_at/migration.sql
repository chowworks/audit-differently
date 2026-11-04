-- When the workspace's payroll match last saved the month: a month started after it shows it is not matched yet, so
-- the page asks for Match again rather than showing the month empty. Months that already hold the match's lines or
-- proof links count as matched when they were last changed.
ALTER TABLE "MonthlyReport" ADD COLUMN "payrollMatchedAt" TIMESTAMP(3);

UPDATE "MonthlyReport" m SET "payrollMatchedAt" = m."updatedAt"
WHERE EXISTS (SELECT 1 FROM "Expense" e WHERE e."monthlyReportId" = m.id AND e."payrollKey" IS NOT NULL)
   OR EXISTS (
     SELECT 1 FROM "ExpenseDocument" d JOIN "Expense" e ON e.id = d."expenseId"
     WHERE e."monthlyReportId" = m.id AND d."byMatch"
   )
   OR EXISTS (
     SELECT 1 FROM "WexPaymentDocument" d JOIN "WexPayment" w ON w.id = d."wexPaymentId"
     WHERE w."monthlyReportId" = m.id AND d."byMatch"
   );
