export default {
  transform: { "^.+\\.ts?$": "ts-jest" },
  preset: "ts-jest",
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", ".next", "dist", "supabase"],
  coverageDirectory: "./coverage",
  coveragePathIgnorePatterns: [
    "node_modules",
    "tests",
    "src/generated",
    "dist",
    "**/*/**.spec*",
  ],
  rootDir: ".",
  moduleNameMapper: {
    "^src/(.*)": "<rootDir>/src/$1",
    "^dto/(.*)": "<rootDir>/dto/$1",
    "^dto$": "<rootDir>/dto",
  },
};
