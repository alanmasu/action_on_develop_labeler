'use strict';

/**
 * Updates the Status (single select) field of a GitHub Project (v2).
 * Only touches items already in the project: never adds anything.
 */

const PROJECT_RE = /^https?:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9_.-]+)\/projects\/(\d+)/;

function parseProjectUrl(url) {
  const m = PROJECT_RE.exec(String(url || '').trim());
  if (!m) {
    throw new Error(
      `Invalid project-url: "${url}". Expected https://github.com/users/<user>/projects/<n> ` +
        'or https://github.com/orgs/<org>/projects/<n>'
    );
  }
  return { kind: m[1] === 'users' ? 'user' : 'organization', login: m[2], number: Number(m[3]) };
}

const tokenHint = (e) =>
  /not accessible by integration|resource not accessible|insufficient scopes|could not resolve to a projectv2/i.test(
    (e && e.message) || ''
  )
    ? ' — GITHUB_TOKEN cannot access projects: pass "project-token" (classic PAT with the "project" scope, ' +
      'fine-grained PAT with Projects read/write, or a GitHub App token).'
    : '';

/**
 * Opens the project and returns setStatus(nodeId, optionName, dryRun).
 * Field and options are validated first, so a wrong name stops the action before touching anything.
 */
async function openProject(gh, { url, fieldName, options }) {
  const p = parseProjectUrl(url);
  let project;
  try {
    const res = await gh.graphql(
      `query($login: String!, $number: Int!) { owner: ${p.kind}(login: $login) {
         projectV2(number: $number) { id title
           fields(first: 100) { nodes {
             ... on ProjectV2FieldCommon { id name dataType }
             ... on ProjectV2SingleSelectField { options { id name } } } } } } }`,
      { login: p.login, number: p.number }
    );
    project = res.owner && res.owner.projectV2;
  } catch (e) {
    throw new Error(`Cannot read project ${url}: ${e.message}${tokenHint(e)}`);
  }
  if (!project) throw new Error(`Project ${url} not found or not accessible with this token.`);

  const fields = (project.fields.nodes || []).filter((f) => f && f.name);
  const field = fields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
  if (!field) {
    throw new Error(`Field "${fieldName}" does not exist in "${project.title}" (fields: ${fields.map((f) => f.name).join(', ')})`);
  }
  if (field.dataType !== 'SINGLE_SELECT') {
    throw new Error(`Field "${field.name}" is of type ${field.dataType}: a single select field like Status is needed.`);
  }
  const optionId = {};
  for (const name of options.filter(Boolean)) {
    const opt = field.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (!opt) {
      throw new Error(`Option "${name}" does not exist in field "${field.name}" (options: ${field.options.map((o) => o.name).join(', ')})`);
    }
    optionId[name] = opt.id;
  }

  return {
    title: project.title,
    /** @returns {Promise<'set'|'missing'>} */
    async setStatus(nodeId, optionName, dryRun) {
      const res = await gh.graphql(
        `query($id: ID!) { node(id: $id) {
           ... on Issue { projectItems(first: 100) { nodes { id project { id } } } } } }`,
        { id: nodeId }
      );
      const items = (res.node && res.node.projectItems && res.node.projectItems.nodes) || [];
      const item = items.find((i) => i.project.id === project.id);
      if (!item) return 'missing';
      if (!dryRun) {
        await gh.graphql(
          `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
             updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f,
               value: { singleSelectOptionId: $o } }) { projectV2Item { id } } }`,
          { p: project.id, i: item.id, f: field.id, o: optionId[optionName] }
        );
      }
      return 'set';
    },
  };
}

module.exports = { parseProjectUrl, openProject, tokenHint };
