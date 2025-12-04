import { useEffect } from "react";
import { List, ActionPanel, Action, getPreferenceValues, showToast, Toast, Icon, Color } from "@raycast/api";
import { Client } from "@notionhq/client";
import { useCachedPromise } from "@raycast/utils";
import type { PageObjectResponse, QueryDatabaseResponse } from "@notionhq/client/build/src/api-endpoints";

// ============================================
// Type Definitions
// ============================================

interface Preferences {
  notionApiToken: string;
  taskDatabaseId: string;
  sprintDatabaseId: string;
  taskIdPropertyName: string;
  taskStatusPropertyName: string;
  sprintRelationPropertyName: string;
  sprintStatusPropertyName: string;
}

interface Task {
  id: string;
  taskId: string;
  title: string;
  status: string;
}

// ============================================
// Notion API Helper Functions
// ============================================

/**
 * Fetches the IDs of all sprints with Status = "Current"
 */
async function getCurrentSprintIds(notion: Client, preferences: Preferences): Promise<string[]> {
  const response: QueryDatabaseResponse = await notion.databases.query({
    database_id: preferences.sprintDatabaseId,
    filter: {
      property: preferences.sprintStatusPropertyName,
      status: {
        equals: "Current",
      },
    },
  });

  return response.results.map((page) => page.id);
}

/**
 * Fetches tasks that:
 * - Are related to one of the current sprints
 * - Do NOT have Status = "Done"
 */
async function getTasks(notion: Client, preferences: Preferences, currentSprintIds: string[]): Promise<Task[]> {
  // If no current sprints found, return empty array
  if (currentSprintIds.length === 0) {
    return [];
  }

  // Build the base filter: exclude Done tasks
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filters: any[] = [
    {
      property: preferences.taskStatusPropertyName,
      status: {
        does_not_equal: "Done",
      },
    },
  ];

  // Add sprint relation filter(s)
  // If multiple current sprints, use OR condition
  if (currentSprintIds.length === 1) {
    filters.push({
      property: preferences.sprintRelationPropertyName,
      relation: {
        contains: currentSprintIds[0],
      },
    });
  } else {
    // Multiple sprints: create OR filter
    const sprintFilters = currentSprintIds.map((sprintId) => ({
      property: preferences.sprintRelationPropertyName,
      relation: {
        contains: sprintId,
      },
    }));
    filters.push({
      or: sprintFilters,
    });
  }

  const response: QueryDatabaseResponse = await notion.databases.query({
    database_id: preferences.taskDatabaseId,
    filter: {
      and: filters,
    },
    sorts: [
      {
        property: preferences.taskIdPropertyName,
        direction: "ascending",
      },
    ],
  });

  // Transform Notion pages to Task objects
  return response.results
    .filter((page): page is PageObjectResponse => "properties" in page)
    .map((page) => extractTask(page, preferences));
}

/**
 * Extracts a Task object from a Notion page
 */
function extractTask(page: PageObjectResponse, preferences: Preferences): Task {
  const properties = page.properties;

  // Extract Task ID
  const taskIdProp = properties[preferences.taskIdPropertyName];
  const taskId = extractPropertyValue(taskIdProp);

  // Extract Title (find the title-type property)
  const titleProp = Object.values(properties).find((prop) => prop.type === "title");
  const title = extractTitleValue(titleProp);

  // Extract Status
  const statusProp = properties[preferences.taskStatusPropertyName];
  const status = extractStatusValue(statusProp);

  return {
    id: page.id,
    taskId: taskId || `[No ID]`,
    title: title || "[Untitled]",
    status: status || "[No Status]",
  };
}

/**
 * Extracts the string value from various Notion property types
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPropertyValue(prop: any): string {
  if (!prop) return "";

  switch (prop.type) {
    case "rich_text":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return prop.rich_text.map((t: any) => t.plain_text).join("");
    case "title":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return prop.title.map((t: any) => t.plain_text).join("");
    case "unique_id":
      // Handle Notion's unique_id type (e.g., "TASK-123")
      if (prop.unique_id?.prefix) {
        return `${prop.unique_id.prefix}-${prop.unique_id.number}`;
      }
      return String(prop.unique_id?.number ?? "");
    case "number":
      return String(prop.number ?? "");
    case "formula":
      // Handle formula results
      if (prop.formula?.type === "string") {
        return prop.formula.string ?? "";
      }
      if (prop.formula?.type === "number") {
        return String(prop.formula.number ?? "");
      }
      return "";
    default:
      return "";
  }
}

/**
 * Extracts the title string from a title property
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTitleValue(prop: any): string {
  if (!prop || prop.type !== "title") return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prop.title.map((t: any) => t.plain_text).join("");
}

/**
 * Extracts the status name from a status property
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractStatusValue(prop: any): string {
  if (!prop || prop.type !== "status") return "";
  return prop.status?.name ?? "";
}

/**
 * Returns a color based on status name for visual distinction
 */
function getStatusColor(status: string): Color {
  const statusLower = status.toLowerCase();
  if (statusLower.includes("progress") || statusLower.includes("doing")) {
    return Color.Blue;
  }
  if (statusLower.includes("review") || statusLower.includes("waiting")) {
    return Color.Yellow;
  }
  if (statusLower.includes("blocked") || statusLower.includes("hold")) {
    return Color.Red;
  }
  if (statusLower.includes("todo") || statusLower.includes("backlog")) {
    return Color.SecondaryText;
  }
  return Color.PrimaryText;
}

// ============================================
// Main Command Component
// ============================================

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();

  // Fetch tasks using cached promise for better UX
  const {
    isLoading,
    data: tasks,
    revalidate,
    error,
  } = useCachedPromise(
    async () => {
      // Initialize Notion client inside the callback
      const notion = new Client({ auth: preferences.notionApiToken });

      // Step 1: Get IDs of current sprints
      const currentSprintIds = await getCurrentSprintIds(notion, preferences);

      if (currentSprintIds.length === 0) {
        showToast({
          style: Toast.Style.Animated,
          title: "No Current Sprint Found",
          message: "No sprint with Status 'Current' was found",
        });
        return [];
      }

      // Step 2: Get tasks related to current sprints (excluding Done)
      const tasks = await getTasks(notion, preferences, currentSprintIds);

      return tasks;
    },
    [],
    {
      keepPreviousData: true,
      failureToastOptions: {
        title: "Failed to fetch tasks",
      },
    },
  );

  // Handle errors
  useEffect(() => {
    if (error) {
      console.error("Error fetching tasks:", error);

      let errorMessage = error.message;

      // Provide more helpful error messages
      if (error.message.includes("Could not find database")) {
        errorMessage = "Database not found. Please check your database IDs in preferences.";
      } else if (error.message.includes("API token is invalid") || error.message.includes("Unauthorized")) {
        errorMessage = "Invalid API token. Please check your Notion API token in preferences.";
      } else if (error.message.includes("property")) {
        errorMessage = "Property not found. Please check your property name settings in preferences.";
      }

      showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: errorMessage,
      });
    }
  }, [error]);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search tasks by ID or name...">
      {!isLoading && tasks?.length === 0 ? (
        <List.EmptyView
          title="No Tasks Found"
          description="No tasks found in the current sprint (or no current sprint exists)"
          icon={Icon.MagnifyingGlass}
        />
      ) : (
        tasks?.map((task) => (
          <List.Item
            key={task.id}
            title={task.taskId}
            subtitle={task.title}
            accessories={[
              {
                tag: {
                  value: task.status,
                  color: getStatusColor(task.status),
                },
              },
            ]}
            actions={
              <ActionPanel>
                <ActionPanel.Section title="Task ID Actions">
                  <Action.Paste title="Paste Task ID" content={task.taskId} icon={Icon.Clipboard} />
                  <Action.CopyToClipboard
                    title="Copy Task ID"
                    content={task.taskId}
                    shortcut={{ modifiers: ["cmd"], key: "c" }}
                  />
                </ActionPanel.Section>
                <ActionPanel.Section title="Other Actions">
                  <Action.CopyToClipboard
                    title="Copy Task ID and Name"
                    content={`${task.taskId}: ${task.title}`}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                  />
                  <Action
                    title="Refresh Tasks"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ["cmd"], key: "r" }}
                    onAction={() => revalidate()}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
