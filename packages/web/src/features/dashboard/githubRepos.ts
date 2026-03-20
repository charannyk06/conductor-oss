export type GitHubRepo = {
  name: string;
  fullName: string;
  httpsUrl: string;
  sshUrl: string;
  defaultBranch: string;
  private: boolean;
  description?: string | null;
  updatedAt?: string | null;
  ownerLogin?: string | null;
  permission?: string | null;
};

export function filterGitHubRepos(repos: GitHubRepo[], search: string): GitHubRepo[] {
  const query = search.trim().toLowerCase();
  if (query.length === 0) {
    return repos;
  }

  return repos.filter((repo) => {
    return repo.fullName.toLowerCase().includes(query)
      || repo.name.toLowerCase().includes(query)
      || (repo.ownerLogin ?? "").toLowerCase().includes(query)
      || (repo.description ?? "").toLowerCase().includes(query)
      || repo.defaultBranch.toLowerCase().includes(query);
  });
}
