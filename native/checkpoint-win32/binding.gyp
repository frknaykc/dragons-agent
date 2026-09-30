{
  "targets": [{
    "target_name": "checkpoint_win32",
    "sources": ["open.cc"],
    "conditions": [["OS=='win'", {
      "defines": ["NOMINMAX", "WIN32_LEAN_AND_MEAN", "_WIN32_WINNT=0x0602"],
      "libraries": ["kernel32.lib"]
    }, {
      "sources!": ["open.cc"]
    }]]
  }]
}
