import * as path from "path";
import * as vscode from "vscode";
import { instrumentOperation, sendInfo, sendOperationError, setErrorCode } from "vscode-extension-telemetry-wrapper";

import * as anchor from "../anchor";
import * as commands from "../commands";
import * as lsPlugin from "../languageServerPlugin";
import * as utility from "../utility";

export async function buildWorkspace(): Promise<boolean> {
    const buildResult = await instrumentOperation("build", async (operationId: string) => {
        let error;
        try {
            await commands.executeJavaExtensionCommand(commands.JAVA_BUILD_WORKSPACE, false);
        } catch (err) {
            error = err;
        }

        return {
            error,
            operationId,
        };
    })();

    if (buildResult.error) {
        return handleBuildFailure(buildResult.operationId, buildResult.error);
    }
    return true;
}

async function handleBuildFailure(operationId: string, err: any): Promise<boolean> {
    if (err instanceof utility.JavaExtensionNotEnabledError) {
        utility.guideToInstallJavaExtension();
        return false;
    }

    const error: Error = new utility.UserError({
        message: "Build failed",
    });
    setErrorCode(error, Number(err));
    sendOperationError(operationId, "build", error);
    if (err === lsPlugin.CompileWorkspaceStatus.WITHERROR || err === lsPlugin.CompileWorkspaceStatus.FAILED) {
        if (checkErrorsReportedByJavaExtension()) {
            vscode.commands.executeCommand("workbench.actions.view.problems");
        }

        const ans = await vscode.window.showErrorMessage("Build failed, do you want to continue?",
            "Proceed", "Fix...", "Cancel");
        sendInfo(operationId, {
            operationName: "build",
            choiceForBuildError: ans || "esc",
        });
        if (ans === "Proceed") {
            return true;
        } else if (ans === "Fix...") {
            showFixSuggestions(operationId);
        }

        return false;
    }

    return false;
}

function checkErrorsReportedByJavaExtension(): boolean {
    const problems = vscode.languages.getDiagnostics() || [];
    for (const problem of problems) {
        const fileName = path.basename(problem[0].fsPath || "");
        if (fileName.endsWith(".java") || fileName === "pom.xml" || fileName.endsWith(".gradle")) {
            if (problem[1].filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length) {
                return true;
            }
        }
    }

    return false;
}

async function showFixSuggestions(operationId: string) {
    let buildFiles = [];
    try {
        buildFiles = await lsPlugin.resolveBuildFiles();
    } catch (error) {
        // do nothing
    }

    const pickitems = [];
    pickitems.push({
        label: "Clean workspace cache",
        detail: "Clean the stale workspace and reload the window",
    });
    if (buildFiles.length) {
        pickitems.push({
            label: "Update project configuration",
            detail: "Force the language server to update the project configuration/classpath",
        });
    }
    pickitems.push({
        label: "Open log file",
        detail: "Open log file to view more details for the build errors",
    });
    pickitems.push({
        label: "Troubleshooting guide",
        detail: "Find more detail about the troubleshooting steps",
    });

    const ans = await vscode.window.showQuickPick(pickitems, {
        placeHolder: "Please fix the errors in PROBLEMS first, then try the fix suggestions below.",
    });
    sendInfo(operationId, {
        operationName: "build",
        choiceForBuildFix: ans ? ans.label : "esc",
    });
    if (!ans) {
        return;
    }

    if (ans.label === "Clean workspace cache") {
        vscode.commands.executeCommand("java.clean.workspace");
    } else if (ans.label === "Update project configuration") {
        for (const buildFile of buildFiles) {
            await vscode.commands.executeCommand("java.projectConfiguration.update", vscode.Uri.parse(buildFile));
        }
    } else if (ans.label === "Open log file") {
        vscode.commands.executeCommand("java.open.serverLog");
    } else if (ans.label === "Troubleshooting guide") {
        utility.openTroubleshootingPage("Build failed", anchor.BUILD_FAILED);
    }
}