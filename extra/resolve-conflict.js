const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

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

async function main() {
    if (!OPENAI_API_KEY || !GITHUB_TOKEN) {
        console.error(
            "Error: OPENAI_API_KEY or GITHUB_TOKEN environment variable is not set."
        );
        process.exit(1);
    }

    const conflictedFiles = getConflictedFiles();
    if (conflictedFiles.length === 0) {
        console.log("No conflicts found.");
        return;
    }

    console.log(`Conflicted files found: ${conflictedFiles.join(", ")}`);
    let body = "### AI-Assisted Conflict Resolution Report\n\n";

    for (const file of conflictedFiles) {
        try {
            console.log(`Attempting AI resolution for ${file}...`);
            const aiResolvedContent = await resolveWithAI(file);

            fs.writeFileSync(file, aiResolvedContent, "utf-8");
            runCommand(`git add ${file}`);
            console.log(`Resolved ${file} with AI assistance.`);
            commentBody += `✅ Resolved \`${file}\` successfully.\n`;
        } catch (error) {
            console.error(`Error resolving ${file}:`, error);
            commentBody += `❌ Could not resolve \`${file}\`: ${error}\n`;
        }
    }

    runCommand("git commit -m 'Auto-resolved conflicts with AI assistance'");

    await postCommentToPR(commentBody);
}

main().catch((error) => {
    console.error("Error in conflict resolution:", error);
    process.exit(1);
});
