'use strict';

/**
 * Aggiornamento del campo Status (single select) di un GitHub Project (v2).
 * Tocca solo elementi già presenti nel project: non aggiunge nulla.
 */

const PROJECT_RE = /^https?:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9_.-]+)\/projects\/(\d+)/;

function parseProjectUrl(url) {
  const m = PROJECT_RE.exec(String(url || '').trim());
  if (!m) {
    throw new Error(
      `project-url non valido: "${url}". Atteso https://github.com/users/<utente>/projects/<n> ` +
        'oppure https://github.com/orgs/<org>/projects/<n>'
    );
  }
  return { kind: m[1] === 'users' ? 'user' : 'organization', login: m[2], number: Number(m[3]) };
}

const tokenHint = (e) =>
  /not accessible by integration|resource not accessible|insufficient scopes|could not resolve to a projectv2/i.test(
    (e && e.message) || ''
  )
    ? ' — il GITHUB_TOKEN non può accedere ai project: passa "project-token" (PAT classic con scope "project", ' +
      'o fine-grained con Projects read/write, o token di GitHub App).'
    : '';

/**
 * Prepara il project e restituisce una funzione setStatus(nodeId, optionName, where).
 * Valida subito campo e opzioni, così un nome sbagliato ferma l'action prima di toccare qualsiasi cosa.
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
    throw new Error(`Project ${url} non leggibile: ${e.message}${tokenHint(e)}`);
  }
  if (!project) throw new Error(`Project ${url} non trovato o non accessibile con questo token.`);

  const fields = (project.fields.nodes || []).filter((f) => f && f.name);
  const field = fields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
  if (!field) {
    throw new Error(`Campo "${fieldName}" inesistente in "${project.title}" (campi: ${fields.map((f) => f.name).join(', ')})`);
  }
  if (field.dataType !== 'SINGLE_SELECT') {
    throw new Error(`Il campo "${field.name}" è di tipo ${field.dataType}: serve un campo a scelta singola come Status.`);
  }
  const optionId = {};
  for (const name of options.filter(Boolean)) {
    const opt = field.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (!opt) {
      throw new Error(`Opzione "${name}" inesistente nel campo "${field.name}" (opzioni: ${field.options.map((o) => o.name).join(', ')})`);
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
