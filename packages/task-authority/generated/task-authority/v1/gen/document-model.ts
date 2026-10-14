import type { DocumentModelGlobalState } from "document-model";

export const documentModel: DocumentModelGlobalState = {
  id: "kilgore/task",
  name: "Task Authority",
  author: {
    name: "Chris Powers",
    website: "https://kapelle.ai",
  },
  extension: "phtask",
  description:
    "Private, self-hosted authority for general cross-project tasks.",
  specifications: [
    {
      state: {
        local: {
          schema: "",
          examples: [],
          initialValue: "",
        },
        global: {
          schema:
            "enum TaskStatus { OPEN SNOOZED BLOCKED DONE ARCHIVED }\nenum TaskPriority { HIGH MED LOW }\nenum TaskSource { HUMAN CLI AGENT PERSONAL_CRM MIGRATION }\n\ntype TaskBlock {\n  reason: String!\n  setAt: DateTime!\n  setBy: String!\n  clearedAt: DateTime\n  clearedBy: String\n  resolution: String\n}\n\ntype TaskComment {\n  id: ID!\n  bodyMarkdown: String!\n  addedAt: DateTime!\n  addedBy: String!\n}\n\ntype TaskExternalRef {\n  id: ID!\n  authority: String!\n  opaqueId: String!\n  deepLink: String\n  addedAt: DateTime!\n  addedBy: String!\n}\n\ntype TaskAuthorityState {\n  id: PHID\n  schemaVersion: Int!\n  title: String!\n  bodyMarkdown: String!\n  status: TaskStatus!\n  priority: TaskPriority\n  projectId: String\n  labels: [String!]!\n  ownerId: String!\n  assigneeId: String\n  dueAt: DateTime\n  snoozedUntil: DateTime\n  createdAt: DateTime\n  updatedAt: DateTime\n  completedAt: DateTime\n  archivedAt: DateTime\n  openBlock: TaskBlock\n  blockHistory: [TaskBlock!]!\n  comments: [TaskComment!]!\n  dependsOn: [PHID!]!\n  externalRefs: [TaskExternalRef!]!\n  source: TaskSource!\n  sourceRef: String\n  createdBy: String!\n  updatedBy: String!\n}",
          examples: [],
          initialValue:
            '{"id":null,"schemaVersion":1,"title":"","bodyMarkdown":"","status":"OPEN","priority":null,"projectId":null,"labels":[],"ownerId":"","assigneeId":null,"dueAt":null,"snoozedUntil":null,"createdAt":null,"updatedAt":null,"completedAt":null,"archivedAt":null,"openBlock":null,"blockHistory":[],"comments":[],"dependsOn":[],"externalRefs":[],"source":"HUMAN","sourceRef":null,"createdBy":"","updatedBy":""}',
        },
      },
      modules: [
        {
          id: "task-content-v1",
          name: "content",
          description:
            "Task creation, content, classification, and scheduling.",
          operations: [
            {
              id: "create-task-v1",
              name: "CREATE_TASK",
              description: "CREATE_TASK operation for Task Authority v1.",
              schema:
                "input CreateTaskInput {\n  id: PHID!\n  title: String!\n  bodyMarkdown: String\n  projectId: String\n  dueAt: DateTime\n  priority: TaskPriority\n  labels: [String!]\n  ownerId: String!\n  assigneeId: String\n  source: TaskSource!\n  sourceRef: String\n  occurredAt: DateTime!\n  actorId: String!\n}",
              template: "CREATE_TASK operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "update-title-v1",
              name: "UPDATE_TITLE",
              description: "UPDATE_TITLE operation for Task Authority v1.",
              schema:
                "input UpdateTitleInput { title: String! occurredAt: DateTime!\n  actorId: String!\n}",
              template: "UPDATE_TITLE operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "update-body-v1",
              name: "UPDATE_BODY",
              description: "UPDATE_BODY operation for Task Authority v1.",
              schema:
                "input UpdateBodyInput { bodyMarkdown: String! occurredAt: DateTime!\n  actorId: String!\n}",
              template: "UPDATE_BODY operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "set-project-v1",
              name: "SET_PROJECT",
              description: "SET_PROJECT operation for Task Authority v1.",
              schema:
                "input SetProjectInput { projectId: String occurredAt: DateTime!\n  actorId: String!\n}",
              template: "SET_PROJECT operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "set-due-v1",
              name: "SET_DUE",
              description: "SET_DUE operation for Task Authority v1.",
              schema:
                "input SetDueInput { dueAt: DateTime occurredAt: DateTime!\n  actorId: String!\n}",
              template: "SET_DUE operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "set-priority-v1",
              name: "SET_PRIORITY",
              description: "SET_PRIORITY operation for Task Authority v1.",
              schema:
                "input SetPriorityInput { priority: TaskPriority occurredAt: DateTime!\n  actorId: String!\n}",
              template: "SET_PRIORITY operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "set-assignee-v1",
              name: "SET_ASSIGNEE",
              description: "SET_ASSIGNEE operation for Task Authority v1.",
              schema:
                "input SetAssigneeInput { assigneeId: String occurredAt: DateTime!\n  actorId: String!\n}",
              template: "SET_ASSIGNEE operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "task-lifecycle-v1",
          name: "lifecycle",
          description: "Auditable task lifecycle without destructive deletion.",
          operations: [
            {
              id: "complete-task-v1",
              name: "COMPLETE_TASK",
              description: "COMPLETE_TASK operation for Task Authority v1.",
              schema:
                "input CompleteTaskInput { resolution: String occurredAt: DateTime!\n  actorId: String!\n}",
              template: "COMPLETE_TASK operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "reopen-task-v1",
              name: "REOPEN_TASK",
              description: "REOPEN_TASK operation for Task Authority v1.",
              schema:
                "input ReopenTaskInput { reason: String occurredAt: DateTime!\n  actorId: String!\n}",
              template: "REOPEN_TASK operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "snooze-task-v1",
              name: "SNOOZE_TASK",
              description: "SNOOZE_TASK operation for Task Authority v1.",
              schema:
                "input SnoozeTaskInput { snoozedUntil: DateTime! reason: String occurredAt: DateTime!\n  actorId: String!\n}",
              template: "SNOOZE_TASK operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "unsnooze-task-v1",
              name: "UNSNOOZE_TASK",
              description: "UNSNOOZE_TASK operation for Task Authority v1.",
              schema:
                "input UnsnoozeTaskInput { occurredAt: DateTime!\n  actorId: String!\n}",
              template: "UNSNOOZE_TASK operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "block-task-v1",
              name: "BLOCK_TASK",
              description: "BLOCK_TASK operation for Task Authority v1.",
              schema:
                "input BlockTaskInput { reason: String! occurredAt: DateTime!\n  actorId: String!\n}",
              template: "BLOCK_TASK operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "unblock-task-v1",
              name: "UNBLOCK_TASK",
              description: "UNBLOCK_TASK operation for Task Authority v1.",
              schema:
                "input UnblockTaskInput { resolution: String occurredAt: DateTime!\n  actorId: String!\n}",
              template: "UNBLOCK_TASK operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "archive-task-v1",
              name: "ARCHIVE_TASK",
              description: "ARCHIVE_TASK operation for Task Authority v1.",
              schema:
                "input ArchiveTaskInput { reason: String occurredAt: DateTime!\n  actorId: String!\n}",
              template: "ARCHIVE_TASK operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "task-context-v1",
          name: "context",
          description:
            "Labels, comments, dependencies, and opaque external references.",
          operations: [
            {
              id: "add-label-v1",
              name: "ADD_LABEL",
              description: "ADD_LABEL operation for Task Authority v1.",
              schema:
                "input AddLabelInput { label: String! occurredAt: DateTime!\n  actorId: String!\n}",
              template: "ADD_LABEL operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "remove-label-v1",
              name: "REMOVE_LABEL",
              description: "REMOVE_LABEL operation for Task Authority v1.",
              schema:
                "input RemoveLabelInput { label: String! occurredAt: DateTime!\n  actorId: String!\n}",
              template: "REMOVE_LABEL operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "add-comment-v1",
              name: "ADD_COMMENT",
              description: "ADD_COMMENT operation for Task Authority v1.",
              schema:
                "input AddCommentInput { id: ID! bodyMarkdown: String! occurredAt: DateTime!\n  actorId: String!\n}",
              template: "ADD_COMMENT operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "add-dependency-v1",
              name: "ADD_DEPENDENCY",
              description: "ADD_DEPENDENCY operation for Task Authority v1.",
              schema:
                "input AddDependencyInput { taskId: PHID! occurredAt: DateTime!\n  actorId: String!\n}",
              template: "ADD_DEPENDENCY operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "remove-dependency-v1",
              name: "REMOVE_DEPENDENCY",
              description: "REMOVE_DEPENDENCY operation for Task Authority v1.",
              schema:
                "input RemoveDependencyInput { taskId: PHID! occurredAt: DateTime!\n  actorId: String!\n}",
              template: "REMOVE_DEPENDENCY operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "add-external-ref-v1",
              name: "ADD_EXTERNAL_REF",
              description: "ADD_EXTERNAL_REF operation for Task Authority v1.",
              schema:
                "input AddExternalRefInput {\n  id: ID!\n  authority: String!\n  opaqueId: String!\n  deepLink: String\n  occurredAt: DateTime!\n  actorId: String!\n}",
              template: "ADD_EXTERNAL_REF operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "remove-external-ref-v1",
              name: "REMOVE_EXTERNAL_REF",
              description:
                "REMOVE_EXTERNAL_REF operation for Task Authority v1.",
              schema:
                "input RemoveExternalRefInput { id: ID! occurredAt: DateTime!\n  actorId: String!\n}",
              template: "REMOVE_EXTERNAL_REF operation for Task Authority v1.",
              reducer: "",
              errors: [],
              examples: [],
              scope: "global",
            },
          ],
        },
      ],
      version: 1,
      changeLog: [],
    },
  ],
};
