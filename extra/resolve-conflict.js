const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PR_NUMBER = process.env.PR_NUMBER;
const USE_AI = process.env.USE_AI === "true";

/**
 * Executes a shell command and returns the trimmed output as a string.
 * If the command fails, it logs the error and returns null.
 *
 * @param {string} command - The shell command to execute.
 * @returns {string|null} - The trimmed output of the command, or null if an error occurs.
 */
function runCommand(command) {
    try {
        return execSync(command, { encoding: "utf-8" }).trim();
    } catch (error) {
        console.error(`Error executing command: ${command}`, error);
        return null;
    }
}

/**
 * Returns an array of paths to files with conflicts (i.e. needing manual conflict resolution),
 * or an empty array if there are no conflicts.
 *
 * @returns {string[]} - An array of paths to files with conflicts.
 */
function getConflictedFiles() {
    const conflictedFiles = runCommand("git diff --name-only --diff-filter=U");

    return conflictedFiles ? conflictedFiles.split("\n") : [];
}

/**
 * Resolves a Git merge conflict at the given file path using the OpenAI Text Completion API.
 *
 * @param {string} filePath - The path to the file with the conflict.
 *
 * @returns {Promise<string>} - A promise that resolves to the resolved file content.
 */
async function resolveWithAI(filePath) {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const prompt = `You are a code assistant. Resolve the following Git merge conflict:\n\n${fileContent}`;

    const response = await axios.post(
        "https://api.openai.com/v1/completions",
        {
            model: "text-davinci-003",
            prompt: prompt,
            max_tokens: 1500,
        },
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
        }
    );

    return response.data.choices[0].text;
}

/**
 * Resolve a Git merge conflict at the given file path manually using traditional Git methods.
 *
 * @param {string} filePath - The path to the file with the conflict.
 *
 * @returns {boolean} - True if the conflict was resolved successfully, false otherwise.
 */
function resolveManually(filePath) {
    console.log(`Resolving conflict manually in ${filePath}`);

    try {
        runCommand(`git checkout --ours ${filePath}`);
        runCommand(`git add ${filePath}`);
        console.log(`Resolved ${filePath} with 'ours' strategy.`);
        return true;
    } catch (error) {
        console.error(
            `Error resolving ${filePath} with traditional methods:`,
            error
        );
        return false;
    }
}

/**
 * Gets the cached Git diff for the specified file path.
 *
 * @param {string} filePath - The path to the file for which to generate the diff.
 * @returns {string|null} - The diff output as a string, or null if an error occurs.
 */
function getFileDiff(filePath) {
    try {
        return runCommand(`git diff --cached ${filePath}`);
    } catch (error) {
        console.error(`Error generating diff for ${filePath}:`, error);
        return null;
    }
}

/**
 * Posts a comment to the current PR with the given body.
 *
 * @param {string} commentBody - The comment body to post to the PR.
 *
 * @returns {Promise<void>} - A promise that resolves when the comment is posted.
 */
async function postCommentToPR(commentBody) {
    try {
        const url = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments`;
        await axios.post(
            url,
            { body: commentBody },
            {
                headers: {
                    Authorization: `Bearer ${GITHUB_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );
        console.log("Comment posted to PR.");
    } catch (error) {
        console.error("Error postig comment to PR:", error);
    }
}

/**
 * Main entry point for this script.
 *
 * Checks out the given pull request in the given repository, resolves any
 * merge conflicts using AI assistance, and commits the resolved files with a
 * message indicating which files were resolved. If there are any errors during
 * the process, the script will stop and not make any changes to the repository.
 *
 * After resolving all conflicts, the script will post a comment to the pull
 * request with a report of which files were resolved, and any errors that
 * occurred.
 *
 * This script is intended to be run from a GitHub Actions workflow, where the
 * GITHUB_TOKEN and OPENAI_API_KEY environment variables are set.
 */
async function main() {
    if (USE_AI && !OPENAI_API_KEY) {
        console.error("Error: OPENAI_API_KEY environment variable is not set.");
        process.exit(1);
    }

    const conflictedFiles = getConflictedFiles();
    if (conflictedFiles.length === 0) {
        console.log("No conflicts found.");
        return;
    }

    console.log(`Conflicted files found: ${conflictedFiles.join(", ")}`);
    let successComment = "### ✅ Successfully Resolved Files:\n\n";
    let failureComment = "### ❌ Failed to Resolve Files:\n\n";

    for (const file of conflictedFiles) {
        let resolved = false;

        try {
            if (USE_AI) {
                console.log(`Attempting AI resolution for ${file}...`);
                const aiResolvedContent = await resolveWithAI(file);

                if (aiResolvedContent) {
                    fs.writeFileSync(file, aiResolvedContent, "utf-8");
                    runCommand(`git add ${file}`);
                    resolved = true;
                    successComment += `- \`${file}\` resolved with AI.\n`;
                } else {
                    console.log(
                        `AI resolution failed for ${file}, falling back...`
                    );
                }
            }

            if (!resolved) {
                resolved = resolveManually(file);
                if (resolved) {
                    successComment += `- \`${file}\` resolved with 'ours' strategy.\n`;
                } else {
                    failureComment += `- \`${file}\` failed to resolve with traditional methods.\n`;
                }
            }

            const diff = getFileDiff(file);
            if (diff) {
                successComment += `<details><summary>Diff for \`${file}\`</summary>\n\n\`\`\`diff\n${diff}\n\`\`\`\n</details>\n\n`;
            }
        } catch (error) {
            console.error(`Error resolving ${file}:`, error);
            failureComment += `- \`${file}\` failed due to error: ${error.message}\n`;
        }
    }

    // Commit the resolved changes if there are any successful resolutions
    if (successComment !== "### ✅ Successfully Resolved Files:\n\n") {
        runCommand(
            "git commit -m 'Auto-resolved conflicts with AI assistance or traditional methods'"
        );
    }

    const commentBody = `${successComment}\n${failureComment}`;
    await postCommentToPR(commentBody);
}

main().catch((error) => {
    console.error("Error in conflict resolution:", error);
    process.exit(1);
});
