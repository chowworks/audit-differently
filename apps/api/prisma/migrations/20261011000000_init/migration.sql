-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fundingSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suggestion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Engagement" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'grant',
    "name" TEXT NOT NULL,
    "funder" TEXT,
    "funderContact" TEXT,
    "solicitation" TEXT,
    "requestedAmount" DECIMAL(12,2),
    "proposalSubmittedOn" TIMESTAMP(3),
    "awardedOn" TIMESTAMP(3),
    "awardAmount" DECIMAL(12,2),
    "number" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "fundingSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reportDueDay" INTEGER NOT NULL DEFAULT 12,
    "indirectTerms" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "waivers" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Engagement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLine" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "engagementId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reportLine" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "narrative" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyReport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "engagementId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "preparedByName" TEXT,
    "authorizedByName" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "comments" TEXT,
    "review" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "deniedReason" TEXT,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "engagementId" TEXT NOT NULL,
    "monthlyReportId" TEXT NOT NULL,
    "itemNumber" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "vendor" TEXT NOT NULL,
    "memo" TEXT,
    "account" TEXT,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "allocatedAmount" DECIMAL(12,2) NOT NULL,
    "allocationType" TEXT NOT NULL DEFAULT 'direct',
    "allocationNote" TEXT,
    "reportLine" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "engagementId" TEXT,
    "kind" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL DEFAULT 'financial',
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "period" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseDocument" (
    "expenseId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "workspaceId" TEXT,

    CONSTRAINT "ExpenseDocument_pkey" PRIMARY KEY ("expenseId","documentId")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "engagementId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "enrollmentStatus" TEXT NOT NULL DEFAULT 'new',
    "currentStatus" TEXT NOT NULL DEFAULT 'active',
    "enrolledAt" TIMESTAMP(3),
    "exitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantDocument" (
    "participantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "workspaceId" TEXT,

    CONSTRAINT "ParticipantDocument_pkey" PRIMARY KEY ("participantId","documentId")
);

-- CreateTable
CREATE TABLE "WexPayment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "monthlyReportId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "payPeriodStart" TIMESTAMP(3) NOT NULL,
    "payPeriodEnd" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(8,2),
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WexPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WexPaymentDocument" (
    "wexPaymentId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "workspaceId" TEXT,

    CONSTRAINT "WexPaymentDocument_pkey" PRIMARY KEY ("wexPaymentId","documentId")
);

-- CreateTable
CREATE TABLE "Check" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "monthlyReportId" TEXT NOT NULL,
    "expenseId" TEXT,
    "wexPaymentId" TEXT,
    "participantId" TEXT,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'rule',
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataAccessLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "subjectId" TEXT,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Suggestion_workspaceId_createdAt_idx" ON "Suggestion"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_workspaceId_idx" ON "Membership"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_workspaceId_key" ON "Membership"("userId", "workspaceId");

-- CreateIndex
CREATE INDEX "Engagement_workspaceId_idx" ON "Engagement"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Engagement_workspaceId_number_key" ON "Engagement"("workspaceId", "number");

-- CreateIndex
CREATE INDEX "BudgetLine_workspaceId_idx" ON "BudgetLine"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLine_engagementId_category_key" ON "BudgetLine"("engagementId", "category");

-- CreateIndex
CREATE INDEX "MonthlyReport_workspaceId_idx" ON "MonthlyReport"("workspaceId");

-- CreateIndex
CREATE INDEX "MonthlyReport_workspaceId_status_dueDate_idx" ON "MonthlyReport"("workspaceId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyReport_engagementId_period_key" ON "MonthlyReport"("engagementId", "period");

-- CreateIndex
CREATE INDEX "Expense_workspaceId_idx" ON "Expense"("workspaceId");

-- CreateIndex
CREATE INDEX "Expense_monthlyReportId_idx" ON "Expense"("monthlyReportId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_engagementId_itemNumber_reportLine_key" ON "Expense"("engagementId", "itemNumber", "reportLine");

-- CreateIndex
CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");

-- CreateIndex
CREATE INDEX "Document_workspaceId_period_idx" ON "Document"("workspaceId", "period");

-- CreateIndex
CREATE INDEX "Document_engagementId_idx" ON "Document"("engagementId");

-- CreateIndex
CREATE INDEX "ExpenseDocument_documentId_idx" ON "ExpenseDocument"("documentId");

-- CreateIndex
CREATE INDEX "ExpenseDocument_workspaceId_idx" ON "ExpenseDocument"("workspaceId");

-- CreateIndex
CREATE INDEX "Participant_workspaceId_idx" ON "Participant"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_engagementId_participantId_key" ON "Participant"("engagementId", "participantId");

-- CreateIndex
CREATE INDEX "ParticipantDocument_documentId_idx" ON "ParticipantDocument"("documentId");

-- CreateIndex
CREATE INDEX "ParticipantDocument_workspaceId_idx" ON "ParticipantDocument"("workspaceId");

-- CreateIndex
CREATE INDEX "WexPayment_workspaceId_idx" ON "WexPayment"("workspaceId");

-- CreateIndex
CREATE INDEX "WexPayment_monthlyReportId_idx" ON "WexPayment"("monthlyReportId");

-- CreateIndex
CREATE INDEX "WexPayment_participantId_idx" ON "WexPayment"("participantId");

-- CreateIndex
CREATE INDEX "WexPaymentDocument_documentId_idx" ON "WexPaymentDocument"("documentId");

-- CreateIndex
CREATE INDEX "WexPaymentDocument_workspaceId_idx" ON "WexPaymentDocument"("workspaceId");

-- CreateIndex
CREATE INDEX "Check_workspaceId_idx" ON "Check"("workspaceId");

-- CreateIndex
CREATE INDEX "Check_monthlyReportId_status_idx" ON "Check"("monthlyReportId", "status");

-- CreateIndex
CREATE INDEX "Check_expenseId_idx" ON "Check"("expenseId");

-- CreateIndex
CREATE INDEX "DataAccessLog_workspaceId_createdAt_idx" ON "DataAccessLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "DataAccessLog_actorId_createdAt_idx" ON "DataAccessLog"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyReport" ADD CONSTRAINT "MonthlyReport_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_monthlyReportId_fkey" FOREIGN KEY ("monthlyReportId") REFERENCES "MonthlyReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseDocument" ADD CONSTRAINT "ExpenseDocument_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseDocument" ADD CONSTRAINT "ExpenseDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantDocument" ADD CONSTRAINT "ParticipantDocument_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantDocument" ADD CONSTRAINT "ParticipantDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WexPayment" ADD CONSTRAINT "WexPayment_monthlyReportId_fkey" FOREIGN KEY ("monthlyReportId") REFERENCES "MonthlyReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WexPayment" ADD CONSTRAINT "WexPayment_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WexPaymentDocument" ADD CONSTRAINT "WexPaymentDocument_wexPaymentId_fkey" FOREIGN KEY ("wexPaymentId") REFERENCES "WexPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WexPaymentDocument" ADD CONSTRAINT "WexPaymentDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_monthlyReportId_fkey" FOREIGN KEY ("monthlyReportId") REFERENCES "MonthlyReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_wexPaymentId_fkey" FOREIGN KEY ("wexPaymentId") REFERENCES "WexPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

